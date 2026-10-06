import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"
import { parseWithEnv } from "../src/parse.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("parser result regressions", () => {
  it.effect("parseWithEnv and parse share whole-input success and failure semantics", () =>
    Effect.sync(() => {
      const grammar = G.literal("ok")
      assert.equal(Result.getOrThrow(parseWithEnv(grammar, "ok", undefined)), undefined)
      assert.equal(parseOk(grammar, "ok"), undefined)
      for (const input of ["no", "ok!"]) {
        const result = parseWithEnv(grammar, input, undefined)
        assert.ok(Result.isFailure(result))
        const error = parseFail(grammar, input)
        assert.equal(result.failure.message, error.message)
        assert.equal(result.failure.pos, error.pos)
        assert.deepEqual(result.failure.expected, error.expected)
      }
      const trailing = parseFail(grammar, "ok!")
      assert.equal(trailing.pos, 2)
      assert.deepEqual(trailing.expected, ["end of input"])
    }))

  it.effect("whole-input checks retain farther diagnostics from a backtracked option", () =>
    Effect.sync(() => {
      const grammar = G.choice([G.literal("abc"), G.literal("a")])
      const error = parseFail(grammar, "ab!")
      assert.equal(error.pos, 2)
      assert.deepEqual(error.expected, ["\"abc\""])
    }))

  it.effect("stops wrapper syntax in opening, inner, closing order", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const character = (name: string, expected: string) =>
        G.regex(/./).pipe(
          G.transformOrFail({
            decode: (value) => {
              calls.push(name)
              return value === expected ? Result.succeed(value) : Result.fail(name)
            },
            encode: (value: string) => Result.succeed(value),
          }),
        )
      const grammar = character("inner", "x").pipe(
        G.between(character("open", "(").pipe(G.skip("(")), character("close", ")").pipe(G.skip(")"))),
      )
      for (
        const [input, expectedCalls] of [
          ["?x)", ["open"]],
          ["(?)", ["open", "inner"]],
          ["(x?", ["open", "inner", "close"]],
        ] as const
      ) {
        calls.length = 0
        const error = parseFail(grammar, input)
        assert.deepEqual(calls, expectedCalls)
        assert.deepEqual(error.expected, [expectedCalls.at(-1)])
        assert.equal(error.pos, expectedCalls.length)
      }
    }))

  it.effect("retries a failed suspend resolution in the next alternative", () =>
    Effect.sync(() => {
      let attempts = 0
      const grammar = G.suspend(() => {
        if (++attempts === 1) throw new Error("try again")
        return G.regex(/ok/, "ok")
      })
      assert.equal(parseOk(G.choice([grammar, grammar]), "ok"), "ok")
      assert.equal(attempts, 2)
    }))

  it.effect("failed suspend retries keep resolution diagnostics without a stale recursion guard", () =>
    Effect.sync(() => {
      let attempts = 0
      const grammar = G.suspend<string>(() => {
        throw new Error(`attempt ${++attempts}`)
      })
      const error = parseFail(G.choice([grammar, grammar]), "")
      assert.equal(attempts, 2)
      assert.equal(error.pos, 0)
      assert.deepEqual(error.expected, ["attempt 1", "attempt 2"])
    }))

  it.effect("a failing choice option does not leave the cursor moved", () =>
    Effect.sync(() => {
      const g = G.gen(function*() {
        const head = yield* G.choice([
          G.literal("abc").pipe(G.as(1)),
          G.literal("ab").pipe(G.as(2)),
        ])
        yield* G.literal("!")
        return { head }
      })
      assert.deepEqual(parseOk(g, "ab!"), { head: 2 })
    }))

  it.effect("a transform guard that rejects rewinds so the next option can try", () =>
    Effect.sync(() => {
      const small = G.integer.pipe(
        G.transform({
          decode: (n) => n,
          encode: (n) => n,
        }),
        G.filter((u: number) => Number.isSafeInteger(u) && u < 10, "small"),
      )
      const g = G.choice([small, G.regex(/\d+/, "digits")])
      assert.equal(parseOk(g, "123"), "123")
      assert.equal(parseOk(g, "3"), 3)
    }))

  it.effect("strict end-of-input reports alongside the deeper expectation", () =>
    Effect.sync(() => {
      const e = parseFail(G.integer.pipe(G.sepBy(",")), "1,2 ")
      assert.equal(e.pos, 3)
      assert.deepEqual(e.expected, ["\",\"", "end of input"])
    }))

  it.effect("gen does not force a suspend thunk at construction", () =>
    Effect.sync(() => {
      const later: G.Grammar<number> = G.suspend(() => target)
      const g = G.gen(function*() {
        const n = yield* later
        return n
      })
      const target = G.integer
      assert.equal(parseOk(g, "7"), 7)
    }))

  it.effect("rejects left recursion without overflowing the stack", () =>
    Effect.sync(() => {
      const recursive: G.Grammar<void> = G.suspend(() => recursive, "recursive")
      assert.match(parseFail(recursive, "").message, /non-left-recursive/)
    }))

  it.effect("rejects an invalid suspend target", () =>
    Effect.sync(() => {
      // SAFETY: deliberately invalid return value exercises runtime validation.
      const invalid = G.suspend(() => undefined as never, "invalid")
      assert.match(parseFail(invalid, "").message, /thunk must return a grammar/)
    }))
})
