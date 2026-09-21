import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"
import { reparse } from "../src/parse.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("parser result regressions", () => {
  it.effect("reparse and parse share whole-input success and failure semantics", () =>
    Effect.sync(() => {
      const grammar = G.literal("ok")
      assert.equal(Result.getOrThrow(reparse(grammar, "ok", undefined)), undefined)
      assert.equal(parseOk(grammar, "ok"), undefined)
      for (const input of ["no", "ok!"]) {
        const result = reparse(grammar, input, undefined)
        assert.ok(Result.isFailure(result))
        const error = parseFail(grammar, input)
        assert.equal(result.failure.message, error.message)
        assert.equal(result.failure.pos, error.pos)
        assert.deepEqual(result.failure.expected, error.expected)
      }
      const trailing = parseFail(grammar, "ok!")
      assert.equal(trailing.pos, 2)
      assert.deepEqual(trailing.expected, ["end of input"])
    }),
  )

  it.effect("whole-input checks retain farther diagnostics from a backtracked option", () =>
    Effect.sync(() => {
      const grammar = G.choice(G.literal("abc"), G.literal("a"))
      const error = parseFail(grammar, "ab!")
      assert.equal(error.pos, 2)
      assert.deepEqual(error.expected, ['"abc"'])
    }),
  )

  it.effect("retries a failed suspend resolution in the next alternative", () =>
    Effect.sync(() => {
      let attempts = 0
      const grammar = G.suspend(() => {
        if (++attempts === 1) throw new Error("try again")
        return G.regex(/ok/, "ok")
      })
      assert.equal(parseOk(G.choice(grammar, grammar), "ok"), "ok")
      assert.equal(attempts, 2)
    }),
  )

  it.effect("failed suspend retries keep resolution diagnostics without a stale recursion guard", () =>
    Effect.sync(() => {
      let attempts = 0
      const grammar = G.suspend<string>(() => {
        throw new Error(`attempt ${++attempts}`)
      })
      const error = parseFail(G.choice(grammar, grammar), "")
      assert.equal(attempts, 2)
      assert.equal(error.pos, 0)
      assert.deepEqual(error.expected, ["attempt 1", "attempt 2"])
    }),
  )
})
