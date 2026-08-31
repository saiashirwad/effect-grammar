import assert from "node:assert/strict"

import { describe, it } from "vitest"

import type { Node } from "../src/core.ts"
import * as G from "../src/index.ts"
import { assertPrintParse } from "../src/testing.ts"
import { parseOk, printOk } from "./helpers.ts"

// One row per Node variant, exercising parse, print, and render together so a
// behavior that drifts between the three interpreters is caught. The `satisfies`
// clause makes a new Node variant a compile error until it gains a row here.

interface Row {
  readonly grammar: G.Grammar<unknown>
  readonly text: string
  readonly value: unknown
  readonly render?: string | undefined
  readonly renderIncludes?: string | undefined
  readonly deps: boolean
}
const row = <A>(spec: {
  grammar: G.Grammar<A>
  text: string
  value: A
  render?: string
  renderIncludes?: string
  deps?: boolean
}): Row => ({
  // SAFETY: the table erases the value type; each row pairs a grammar with a value of its own type.
  grammar: spec.grammar as G.Grammar<unknown>,
  text: spec.text,
  value: spec.value,
  render: spec.render,
  renderIncludes: spec.renderIncludes,
  deps: spec.deps ?? false,
})

const word = G.regex(/[a-z]+/, "word")

const matchGrammar = G.gen(function* () {
  const kind = yield* G.choice(
    G.literal("n").pipe(G.as("n" as const)),
    G.literal("s").pipe(G.as("s" as const)),
  )
  const value = yield* G.match(kind, { n: G.integer, s: word })
  return { kind, value }
})

const takeGrammar = G.gen(function* () {
  const length = yield* G.integer
  yield* G.literal(":")
  const payload = yield* G.take(length)
  return { length, payload }
})

const repeatGrammar = G.gen(function* () {
  const count = yield* G.integer
  yield* G.literal(":")
  const bits = yield* G.repeat(G.regex(/[01]/, "bit"), count)
  return { count, bits }
})

const recursive: G.Grammar<number> = G.suspend(() => G.integer, "rec")

const table = {
  Literal: row({ grammar: G.literal("x"), text: "x", value: undefined, render: '"x"' }),
  Regex: row({ grammar: G.regex(/\d+/, "num"), text: "12", value: "12", render: "<num>" }),
  Gen: row({
    grammar: G.struct({ n: G.integer }),
    text: "5",
    value: { n: 5 },
    render: "n:<integer>",
  }),
  Wrap: row({
    grammar: G.between("(", G.integer, ")"),
    text: "(5)",
    value: 5,
    render: '"(" <integer> ")"',
  }),
  Choice: row({
    grammar: G.choice(G.literal("a").pipe(G.as<number>(1)), G.literal("b").pipe(G.as<number>(2))),
    text: "a",
    value: 1,
    render: '("a" | "b")',
  }),
  Many: row({
    grammar: G.many(G.regex(/[a-z]/, "ch")),
    text: "abc",
    value: ["a", "b", "c"],
    render: "(<ch>)*",
  }),
  Optional: row({
    grammar: G.optional(G.integer),
    text: "5",
    value: 5,
    render: "(<integer>)?",
  }),
  Transform: row({
    grammar: G.regex(/\d+/, "d").pipe(G.transform({ decode: Number, encode: String })),
    text: "7",
    value: 7,
    render: "<d>",
  }),
  Skip: row({
    grammar: G.regex(/\s+/, "sp").pipe(G.skip(" ")),
    text: " ",
    value: undefined,
    render: "<sp>",
  }),
  Label: row({
    grammar: G.integer.pipe(G.label("num")),
    text: "5",
    value: 5,
    render: "<integer>",
  }),
  Suspend: row({ grammar: recursive, text: "9", value: 9, render: "<integer>" }),
  Match: row({
    grammar: matchGrammar,
    text: "n5",
    value: { kind: "n", value: 5 },
    renderIncludes: "match(",
    deps: true,
  }),
  Take: row({
    grammar: takeGrammar,
    text: "2:ab",
    value: { length: 2, payload: "ab" },
    renderIncludes: "<char>{",
    deps: true,
  }),
  RepeatExact: row({
    grammar: repeatGrammar,
    text: "3:101",
    value: { count: 3, bits: ["1", "0", "1"] },
    renderIncludes: "){",
    deps: true,
  }),
} satisfies Record<Node["_tag"], Row>

describe("interpreter table (parse / print / render / law per Node)", () => {
  for (const [tag, entry] of Object.entries(table)) {
    describe(tag, () => {
      it("parses the sample text", () => {
        assert.deepEqual(parseOk(entry.grammar, entry.text), entry.value)
      })

      it("prints a form that parses back to the value", () => {
        const printed = printOk(entry.grammar, entry.value)
        assert.deepEqual(parseOk(entry.grammar, printed), entry.value)
      })

      it("renders", () => {
        const rendered = G.render(entry.grammar)
        assert.ok(rendered.length > 0)
        if (entry.render !== undefined) assert.equal(rendered, entry.render)
        if (entry.renderIncludes !== undefined) assert.ok(rendered.includes(entry.renderIncludes))
      })

      it("obeys parse(print(value)) = value", () => {
        assertPrintParse(entry.grammar, entry.value)
      })
    })
  }
})
