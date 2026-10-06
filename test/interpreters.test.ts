import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Node } from "../src/core.ts"
import * as G from "../src/index.ts"
import { assertPrintParse } from "../src/testing.ts"
import { parseOk } from "./helpers.ts"

interface Sample<A> {
  readonly grammar: G.Grammar<A>
  readonly text: string
  readonly value: A
}

interface Checks {
  readonly parse: () => void
  readonly roundTrip: () => void
}

const row = <A>({ grammar, text, value }: Sample<A>): Checks => ({
  parse: () => assert.deepEqual(parseOk(grammar, text), value),
  roundTrip: () => {
    assertPrintParse(grammar, value)
  },
})

const word = G.regex(/[a-z]+/, "word")

const matchGrammar = G.gen(function*() {
  const kind = yield* G.choice([G.literal("n").pipe(G.as("n" as const)), G.literal("s").pipe(G.as("s" as const))])
  const value = yield* G.match(
    kind,
    [
      ["n", G.integer],
      ["s", word],
    ] as const,
  )
  return { kind, value }
})

const takeGrammar = G.gen(function*() {
  const length = yield* G.integer
  yield* G.literal(":")
  const payload = yield* G.take(length)
  return { length, payload }
})

const recursive: G.Grammar<number> = G.suspend(() => G.integer, "rec")

const table = {
  Literal: row({ grammar: G.literal("x"), text: "x", value: undefined }),
  Regex: row({ grammar: G.regex(/\d+/, "num"), text: "12", value: "12" }),
  Sequence: row({
    grammar: G.gen(function*() {
      const n = yield* G.integer
      const w = yield* word
      return { n, w }
    }),
    text: "5ab",
    value: { n: 5, w: "ab" },
  }),
  Choice: row({
    grammar: G.choice([G.literal("a").pipe(G.as<number>(1)), G.literal("b").pipe(G.as<number>(2))]),
    text: "a",
    value: 1,
  }),
  Optional: row({ grammar: G.optional(G.integer), text: "42", value: 42 }),
  Surrounded: row({ grammar: G.integer.pipe(G.between("[", "]")), text: "[42]", value: 42 }),
  Dispatch: row({
    grammar: G.dispatch("kind", [
      ["n", G.struct({ kind: G.literal("n").pipe(G.as("n" as const)), value: G.integer })],
      ["s", G.struct({ kind: G.literal("s").pipe(G.as("s" as const)), value: word })],
    ]),
    text: "sab",
    value: { kind: "s", value: "ab" },
  }),
  Repeat: row({
    grammar: G.regex(/[a-z]/, "ch").pipe(G.many()),
    text: "abc",
    value: ["a", "b", "c"],
  }),
  Transform: row({
    grammar: G.regex(/\d+/, "d").pipe(G.transform({ decode: Number, encode: String })),
    text: "7",
    value: 7,
  }),
  Skip: row({
    grammar: G.regex(/\s+/, "sp").pipe(G.skip(" ")),
    text: " ",
    value: undefined,
  }),
  Label: row({
    grammar: G.integer.pipe(G.label("num")),
    text: "5",
    value: 5,
  }),
  Suspend: row({ grammar: recursive, text: "9", value: 9 }),
  Match: row({
    grammar: matchGrammar,
    text: "n5",
    value: { kind: "n", value: 5 },
  }),
  Take: row({
    grammar: takeGrammar,
    text: "2:ab",
    value: { length: 2, payload: "ab" },
  }),
} satisfies Record<Node["_tag"], Checks>

describe("interpreter table (parse / print / law per Node)", () => {
  for (const [tag, entry] of Object.entries(table)) {
    describe(tag, () => {
      it.effect("parses the sample text", () => Effect.sync(entry.parse))

      it.effect("obeys parse(print(value)) = value", () => Effect.sync(entry.roundTrip))
    })
  }
})
