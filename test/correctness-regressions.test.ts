import assert from "node:assert/strict"

import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe } from "vitest"

import { count, literal } from "../src/grammar.ts"
import * as Grammar from "../src/grammar.ts"
import { parse, UpstreamError } from "../src/parser.ts"

describe("correctness regressions", () => {
  it.effect("preserves caller-supplied upstream failures", () =>
    Effect.gen(function* () {
      const upstream = new UpstreamError({ cause: "upstream-broke" })
      const result = yield* parse("input", Effect.fail(upstream))

      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.ok(Schema.is(UpstreamError)(result.failure))
        assert.equal(result.failure, upstream)
      }
    }),
  )

  it.effect("rejects invalid count cardinalities", () =>
    Effect.sync(() => {
      for (const n of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        assert.throws(() => count(literal("x"), n), RangeError)
      }
    }),
  )
})

const rawStringNode: Grammar.Node = { _tag: "Literal", value: "raw" }

// @ts-expect-error A raw AST node must not be assignable to Grammar<number>.
const numberGrammar: Grammar.Grammar<number> = rawStringNode
void numberGrammar
