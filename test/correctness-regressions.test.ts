import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect, Schema } from "effect"

import { count, literal } from "../src/grammar.ts"
import * as Grammar from "../src/grammar.ts"
import { parse, UpstreamError } from "../src/parser.ts"

describe("correctness regressions", () => {
  it("preserves caller-supplied upstream failures", () => {
    const upstream = new UpstreamError({ cause: "upstream-broke" })
    const result = Effect.runSync(parse("input", Effect.fail(upstream)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(Schema.is(UpstreamError)(result.failure))
      assert.equal(result.failure, upstream)
    }
  })

  it("rejects invalid count cardinalities", () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => count(literal("x"), n), RangeError)
    }
  })
})

const rawStringNode: Grammar.Node = { _tag: "Literal", value: "raw" }

// @ts-expect-error A raw AST node must not be assignable to Grammar<number>.
const numberGrammar: Grammar.Grammar<number> = rawStringNode
void numberGrammar
