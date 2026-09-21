import * as G from "../src/index.ts"

const kindOf = G.literals("a", "b")

// @ts-expect-error taggedChoice cannot use "value" as its tag
G.taggedChoice("value", { number: G.integer })
// Dynamic tags rely on the runtime reserved-name check.
const dynamicTag: string = "kind"
G.taggedChoice(dynamicTag, { number: G.integer })

// A ref has no value while the grammar is built, so JavaScript cannot branch on it.
G.gen(function* () {
  const kind = yield* kindOf
  // @ts-expect-error a Ref is not a string
  const value = yield* kind === "a" ? G.integer : G.regex(/x/, "x")
  return { kind, value }
})

G.gen(function* () {
  const kind = yield* kindOf
  // @ts-expect-error missing case "b"
  const value = yield* G.match(kind, { a: G.integer })
  return { kind, value }
})

G.gen(function* () {
  const n = yield* G.optional(G.integer)
  // @ts-expect-error number | undefined is not a key
  const value = yield* G.match(n, { 1: G.integer })
  return { n, value }
})

G.gen(function* () {
  const w = yield* G.regex(/x/, "x")
  // @ts-expect-error Ref<string> is not Ref<number>
  const s = yield* G.take(w)
  return { w, s }
})

// The return type unwraps each Ref<A> to A.
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

const opt = G.gen(function* () {
  const port = yield* G.optional(G.integer)
  return { port }
})
const okOpt: G.Type<typeof opt> = { port: undefined }

const matched = G.gen(function* () {
  const kind = yield* kindOf
  const value = yield* G.match(kind, { a: G.integer, b: G.regex(/x/, "x") })
  return { kind, value }
})
const okMatched: G.Type<typeof matched> = { kind: "a", value: 1 }
const okMatchedB: G.Type<typeof matched> = { kind: "b", value: "x" }

// Ref properties remain refs, so they can drive dependent grammars.
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

const s: G.Silent = G.gen(function* () {
  yield* G.literal("a")
})

// @ts-expect-error bare value grammar
G.seq(G.literal("a"), G.integer)

// @ts-expect-error integer is not silent
G.integer.pipe(G.as(1))

const s2: G.Silent = G.seq(G.literal("a"), G.optional(G.between("<", G.symbol("b"), ">")))

// A choice of silent grammars has no canonical print.
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
const onGrammar = G.choiceOn("kind", { plain: plainTagged })
const onValue: G.Type<typeof onGrammar> = {
  kind: "plain",
  v: "a",
}
const onEntries = G.choiceOnEntries("kind", [["plain", plainTagged]] as const)
const onEntriesValue: G.Type<typeof onEntries> = { kind: "plain", v: "a" }
void onEntriesValue
void onValue

type Variant = { readonly kind: "a"; readonly n: 0 } | { readonly kind: "b"; readonly n: number }
const variant = G.filter(
  G.struct({
    kind: G.choice(G.literal("a").pipe(G.as("a")), G.literal("b").pipe(G.as("b"))),
    n: G.integer,
  }),
  (value): value is Variant => value.kind === "b" || value.n === 0,
  "variant",
)
const merged = G.merge(variant, G.struct({ id: G.integer }))
const mergedValue: G.Type<typeof merged> = { kind: "b", n: 42, id: 7 }
// @ts-expect-error kind "a" requires n to be 0
const mergedBad: G.Type<typeof merged> = { kind: "a", n: 42, id: 7 }
void mergedValue
void mergedBad
