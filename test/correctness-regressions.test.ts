import assert from "node:assert/strict"

import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("correctness regressions", () => {
  it("rejects invalid repetition bounds at construction", () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => Grammar.many(Grammar.literal("x"), { min: n }), RangeError)
      assert.throws(() => Grammar.sepBy(Grammar.literal("x"), ",", { min: n }), RangeError)
    }
  })

  it("a failing choice option does not leave the cursor moved", () => {
    const g = Grammar.gen(function* () {
      const head = yield* Grammar.choice(
        Grammar.literal("abc").pipe(Grammar.as(1)),
        Grammar.literal("ab").pipe(Grammar.as(2)),
      )
      yield* Grammar.literal("!")
      return { head }
    })
    assert.deepEqual(parseOk(g, "ab!"), { head: 2 })
  })

  it("a transform guard that rejects rewinds so the next option can try", () => {
    const small = Grammar.integer.pipe(
      Grammar.transform({
        decode: (n) => n,
        encode: (n) => n,
        is: (u) => Number.isSafeInteger(u) && u < 10,
        name: "small",
      }),
    )
    const g = Grammar.choice(small, Grammar.regex(/\d+/, "digits"))
    assert.equal(parseOk(g, "123"), "123")
    assert.equal(parseOk(g, "3"), 3)
  })

  it("strict end-of-input reports alongside the deeper expectation", () => {
    const e = parseFail(Grammar.sepBy(Grammar.integer, ","), "1,2 ")
    assert.equal(e.pos, 3)
    assert.deepEqual(e.expected, ['","', "end of input"])
  })

  it("a gen inside a gen keeps its own bindings, and a failed inner gen backtracks", () => {
    const pair = Grammar.gen(function* () {
      const a = yield* Grammar.integer
      yield* Grammar.literal("=")
      const b = yield* Grammar.integer
      return { a, b }
    })
    const g = Grammar.gen(function* () {
      const first = yield* Grammar.choice(pair, Grammar.integer)
      yield* Grammar.literal(";")
      const second = yield* pair
      return { first, second }
    })
    assert.deepEqual(parseOk(g, "1;2=3"), { first: 1, second: { a: 2, b: 3 } })
    assert.deepEqual(parseOk(g, "1=2;3=4"), { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } })
  })
})

// A raw node must not be assignable to a Grammar.
const rawNode: Grammar.Node = { _tag: "Literal", value: "raw" }
// @ts-expect-error
const notAGrammar: Grammar.Grammar<number> = rawNode
void notAGrammar
