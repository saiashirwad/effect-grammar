import assert from "node:assert/strict"

import { Schema } from "effect"
import { bench, describe } from "vitest"

import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const dense = (size: number, filtered: boolean): G.Grammar<number> => {
  const grammars: Array<G.Grammar<number>> = Array.from({ length: size }, (_, index) =>
    G.suspend(() =>
      G.choice([
        G.integer,
        ...grammars.filter((_, other) => other !== index).map((grammar) => {
          const edge = grammar.pipe(G.between("(", ")"))
          return filtered ? edge.pipe(G.filter((n: number) => n >= 0, "non-negative")) : edge
        }),
      ])
    ))
  return grammars[0]!
}

const timing = { time: 100, iterations: 3, warmupTime: 20, warmupIterations: 1 }

for (const filtered of [false, true]) {
  describe(`${filtered ? "filtered" : "transparent"} dense codec cycles`, () => {
    for (const size of filtered ? [4, 6, 8] : [4, 6, 8, 10]) {
      const grammar = dense(size, filtered)
      const codec = GrammarSchema.codec(grammar)
      const accepts = Schema.is(Schema.toType(codec))
      assert.equal(accepts(1), true)
      assert.equal(accepts("invalid"), false)
      bench(`derive ${size} definitions`, () => {
        GrammarSchema.codec(grammar)
      }, timing)
      bench(`reject ${size} definitions`, () => {
        accepts("invalid")
      }, timing)
    }
  })
}
