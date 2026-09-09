import assert from "node:assert/strict"

import { Predicate, Result } from "effect"
import { describe, it } from "vitest"

import * as B from "../src/binary.ts"
import type { Node } from "../src/core.ts"
import * as G from "../src/index.ts"
import { bytes } from "./helpers.ts"

// One row per Node variant, exercising parse, print, and render together so a
// behavior that drifts between the three interpreters is caught. The `satisfies`
// clause makes a new Node variant a compile error until it gains a row here.

interface Row<A = unknown> {
  readonly grammar: G.Grammar<A>
  readonly text: string | Uint8Array
  readonly value: A
  readonly render?: string | undefined
  readonly renderIncludes?: string | undefined
}
// SAFETY: the table erases the value type; each row pairs a grammar with a value of its own type.
const row = <A>(spec: Row<A>): Row => spec as Row

// A row's sample input picks the interpreters: text rows use the root module, byte rows Binary.
const parse = <A>(grammar: G.Grammar<A>, input: string | Uint8Array): A =>
  Predicate.isString(input)
    ? Result.getOrThrow(G.parse(grammar, input))
    : Result.getOrThrow(B.parse(grammar, input))

const printChecked = <A>(
  grammar: G.Grammar<A>,
  value: A,
  like: string | Uint8Array,
): string | Uint8Array =>
  Predicate.isString(like)
    ? Result.getOrThrow(G.printChecked(grammar, value))
    : Result.getOrThrow(B.printChecked(grammar, value))

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

const derivedPacket = G.gen(function* () {
  const length = yield* B.byte
  const payload = yield* B.bytes(length)
  yield* G.derive(length, payload.length)
  return { payload }
})

const table = {
  Empty: row({ grammar: G.empty, text: "", value: undefined, render: "" }),
  ByteLiteral: row({
    grammar: B.literal(bytes(255)),
    text: bytes(255),
    value: undefined,
    render: "[0xff]",
  }),
  Number: row({ grammar: B.be.uint16, text: bytes(1, 2), value: 258, render: "<uint16BE>" }),
  VarInt: row({ grammar: B.varuint, text: bytes(0x80, 0x01), value: 128, render: "<varuint>" }),
  Derive: row({
    grammar: derivedPacket,
    text: bytes(2, 7, 9),
    value: { payload: bytes(7, 9) },
    render: "payload.length:<uint8> payload:<byte>{payload.length}",
  }),
  Bytes: row({
    grammar: B.bytes(2),
    text: bytes(0, 255),
    value: bytes(0, 255),
    render: "<byte>{2}",
  }),
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
  }),
  Take: row({
    grammar: takeGrammar,
    text: "2:ab",
    value: { length: 2, payload: "ab" },
    renderIncludes: "<char>{",
  }),
  RepeatExact: row({
    grammar: repeatGrammar,
    text: "3:101",
    value: { count: 3, bits: ["1", "0", "1"] },
    renderIncludes: "){",
  }),
} satisfies Record<Node["_tag"], Row>

describe("interpreter table (parse / print / render / law per Node)", () => {
  for (const [tag, entry] of Object.entries(table)) {
    describe(tag, () => {
      it("parses the sample text", () => {
        assert.deepEqual(parse(entry.grammar, entry.text), entry.value)
      })

      it("renders", () => {
        const rendered = G.render(entry.grammar)
        if (entry.render !== undefined) assert.equal(rendered, entry.render)
        if (entry.renderIncludes !== undefined) assert.ok(rendered.includes(entry.renderIncludes))
      })

      it("obeys parse(print(value)) = value", () => {
        assert.deepEqual(printChecked(entry.grammar, entry.value, entry.text), entry.text)
      })
    })
  }
})
