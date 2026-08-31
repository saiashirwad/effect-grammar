import * as G from "../src/index.ts"

const kindOf = G.choice(G.literal("a").pipe(G.as("a")), G.literal("b").pipe(G.as("b")))

// A ref has no value while the grammar is built, so JavaScript cannot branch on it.
G.gen(function* () {
  const kind = yield* kindOf
  // @ts-expect-error a Ref is not a string
  const value = yield* kind === "a" ? G.integer : G.regex(/x/, "x")
  return { kind, value }
})

// match must cover every literal.
G.gen(function* () {
  const kind = yield* kindOf
  // @ts-expect-error missing case "b"
  const value = yield* G.match(kind, { a: G.integer })
  return { kind, value }
})

// match needs a literal ref.
G.gen(function* () {
  const n = yield* G.optional(G.integer)
  // @ts-expect-error number | undefined is not a key
  const value = yield* G.match(n, { 1: G.integer })
  return { n, value }
})

// take and repeat need a number ref.
G.gen(function* () {
  const w = yield* G.regex(/x/, "x")
  // @ts-expect-error Ref<string> is not Ref<number>
  const s = yield* G.take(w)
  return { w, s }
})

// The value type is the return with every Ref<A> replaced by A...
const g = G.gen(function* () {
  yield* G.literal("(")
  const n = yield* G.integer
  const tags = yield* G.many(G.regex(/[a-z]+/, "tag"))
  yield* G.literal(")")
  return { n, tags }
})
const ok: G.Type<typeof g> = { n: 1, tags: ["a"] }
// @ts-expect-error n must be a number
const bad: G.Type<typeof g> = { n: "1", tags: [] }

// ...through a bare ref, a tuple (`as const`, or it is an array), nesting, and constants.
const bare = G.gen(function* () {
  const n = yield* G.integer
  return n
})
const okBare: G.Type<typeof bare> = 1
const tuple = G.gen(function* () {
  const a = yield* G.integer
  const b = yield* G.regex(/x/, "x")
  return [a, b] as const
})
const okTuple: G.Type<typeof tuple> = [1, "x"]
// @ts-expect-error the tuple has two items
const badTuple: G.Type<typeof tuple> = [1]
const nested = G.gen(function* () {
  const a = yield* G.integer
  return { kind: "x", inner: { a } } as const
})
const okNested: G.Type<typeof nested> = { kind: "x", inner: { a: 1 } }
// @ts-expect-error kind is the literal "x"
const badNested: G.Type<typeof nested> = { kind: "y", inner: { a: 1 } }

// An optional binding denotes to A | undefined.
const opt = G.gen(function* () {
  const port = yield* G.optional(G.integer)
  return { port }
})
const okOpt: G.Type<typeof opt> = { port: undefined }

// match yields the union of its cases.
const matched = G.gen(function* () {
  const kind = yield* kindOf
  const value = yield* G.match(kind, { a: G.integer, b: G.regex(/x/, "x") })
  return { kind, value }
})
const okMatched: G.Type<typeof matched> = { kind: "a", value: 1 }
const okMatchedB: G.Type<typeof matched> = { kind: "b", value: "x" }

// A property of a ref is a ref to that property, and only real properties exist.
const header = G.gen(function* () {
  const kind = yield* kindOf
  const size = yield* G.integer
  return { kind, size }
})
G.gen(function* () {
  const h = yield* header
  const body = yield* G.match(h.kind, { a: G.take(h.size), b: G.repeat(G.integer, h.size) })
  // @ts-expect-error no such property
  void h.nope
  return { h, body }
})

// No bindings and no return is silent.
const s: G.Silent = G.gen(function* () {
  yield* G.literal("a")
})

// seq only accepts silent grammars.
// @ts-expect-error bare value grammar
G.seq(G.literal("a"), G.integer)

// `as` only applies to silent grammars.
// @ts-expect-error integer is not silent
G.integer.pipe(G.as(1))

// Silent composition stays silent.
const s2: G.Silent = G.seq(G.literal("a"), G.optional(G.wrap("<", G.symbol("b"), ">")))

// A silent choice is not silent (it has no canonical print).
// @ts-expect-error
const notSilent: G.Silent = G.choice(G.literal("a"), G.literal("b"))

const wordGrammar = G.regex(/[a-z]+/, "word")
// @ts-expect-error Grammar is invariant because printing consumes its value
const widenedGrammar: G.Grammar<unknown> = wordGrammar
// @ts-expect-error the interpreter node is private
void wordGrammar.node

// eslint-disable-next-line unicorn/no-thenable -- Verifies reserved then property typing.
const reservedHeader = G.literal("h").pipe(G.as({ then: "a" as const }))
G.gen(function* () {
  const value = yield* reservedHeader
  const body = yield* G.match(G.get(value, "then"), { a: G.integer })
  return { value, body }
})

const mixedKind = G.choice(G.literal("n").pipe(G.as(1)), G.literal("s").pipe(G.as("1")))
G.gen(function* () {
  const kind = yield* mixedKind
  // @ts-expect-error matchValue must cover every selector literal
  const value = yield* G.matchValue(kind, [[1, G.integer]] as const)
  return { kind, value }
})

void [
  ok,
  bad,
  okBare,
  okTuple,
  badTuple,
  okNested,
  badNested,
  okOpt,
  okMatched,
  okMatchedB,
  s,
  s2,
  notSilent,
  widenedGrammar,
]

// choiceOn: every case must yield a value whose tag field is its key.
const plainTagged = G.regex(/a/, "a").pipe(
  G.transform({ decode: (v) => ({ kind: "plain" as const, v }), encode: (x) => x.v }),
)
const untagged = G.regex(/b/, "b").pipe(G.transform({ decode: (v) => ({ v }), encode: (x) => x.v }))
const misTagged = G.regex(/c/, "c").pipe(
  G.transform({ decode: (v) => ({ kind: "other" as const, v }), encode: (x) => x.v }),
)
G.choiceOn("kind", { plain: plainTagged })
// @ts-expect-error case "b" has no kind field
G.choiceOn("kind", { plain: plainTagged, b: untagged })
// @ts-expect-error case "c" has kind "other", not "c"
G.choiceOn("kind", { plain: plainTagged, c: misTagged })
// The parsed type is the union of the case types.
const onGrammar = G.choiceOn("kind", { plain: plainTagged })
const onValue: G.Type<typeof onGrammar> = {
  kind: "plain",
  v: "a",
}
// choiceOn also accepts ordered [key, grammar] entries.
const onEntries = G.choiceOn("kind", [["plain", plainTagged]] as const)
const onEntriesValue: G.Type<typeof onEntries> = { kind: "plain", v: "a" }
void onEntriesValue
void onValue
