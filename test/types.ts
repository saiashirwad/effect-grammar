import * as G from "../src/index.ts"

const kindOf = G.literals("a", "b")

// @ts-expect-error taggedChoice cannot use "value" as its tag
G.taggedChoice("value", [["number", G.integer]] as const)
const dynamicTag: string = "kind"
G.taggedChoice(dynamicTag, [["number", G.integer]] as const)

G.gen(function*() {
  const kind = yield* kindOf
  // @ts-expect-error a Ref is not a string
  const value = yield* kind === "a" ? G.integer : G.regex(/x/, "x")
  return { kind, value }
})

G.gen(function*() {
  const kind = yield* kindOf
  // @ts-expect-error missing case "b"
  const value = yield* G.match(kind, [["a", G.integer]] as const)
  return { kind, value }
})

G.gen(function*() {
  const n = yield* G.optional(G.integer)
  // @ts-expect-error number | undefined is not a key
  const value = yield* G.match(n, [[1, G.integer]] as const)
  return { n, value }
})

G.gen(function*() {
  const w = yield* G.regex(/x/, "x")
  // @ts-expect-error Ref<string> is not Ref<number>
  const s = yield* G.take(w)
  return { w, s }
})

const g = G.gen(function*() {
  yield* G.literal("(")
  const n = yield* G.integer
  const tags = yield* G.regex(/[a-z]+/, "tag").pipe(G.many())
  yield* G.literal(")")
  return { n, tags }
})
const ok: G.Type<typeof g> = { n: 1, tags: ["a"] }
// @ts-expect-error n must be a number
const bad: G.Type<typeof g> = { n: "1", tags: [] }

const bare = G.gen(function*() {
  const n = yield* G.integer
  return n
})
const okBare: G.Type<typeof bare> = 1
const tuple = G.gen(function*() {
  const a = yield* G.integer
  const b = yield* G.regex(/x/, "x")
  return [a, b] as const
})
const okTuple: G.Type<typeof tuple> = [1, "x"]
// @ts-expect-error the tuple has two items
const badTuple: G.Type<typeof tuple> = [1]
const nested = G.gen(function*() {
  const a = yield* G.integer
  return { kind: "x", inner: { a } } as const
})
const okNested: G.Type<typeof nested> = { kind: "x", inner: { a: 1 } }
// @ts-expect-error kind is the literal "x"
const badNested: G.Type<typeof nested> = { kind: "y", inner: { a: 1 } }

const opt = G.gen(function*() {
  const port = yield* G.optional(G.integer)
  return { port }
})
const okOpt: G.Type<typeof opt> = { port: undefined }

const matched = G.gen(function*() {
  const kind = yield* kindOf
  const value = yield* G.match(
    kind,
    [
      ["a", G.integer],
      ["b", G.regex(/x/, "x")],
    ] as const,
  )
  return { kind, value }
})
const okMatched: G.Type<typeof matched> = { kind: "a", value: 1 }
const okMatchedB: G.Type<typeof matched> = { kind: "b", value: "x" }

const header = G.gen(function*() {
  const kind = yield* kindOf
  const size = yield* G.integer
  return { kind, size }
})
G.gen(function*() {
  const h = yield* header
  const body = yield* G.match(
    G.get(h, "kind"),
    [
      ["a", G.take(G.get(h, "size"))],
      ["b", G.integer.pipe(G.repeat(G.get(h, "size")))],
    ] as const,
  )
  // @ts-expect-error refs are opaque, even for known properties
  void h.kind
  // @ts-expect-error no such property
  void h.nope
  // @ts-expect-error get checks the actual value's keys
  G.get(h, "nope")
  // oxlint-disable-next-line typescript/no-misused-spread -- Verify that spreading loses the opaque ref type.
  const spread = { ...h }
  // @ts-expect-error spreading a ref does not expose its value's fields
  void spread.size
  // @ts-expect-error spreading a ref does not preserve its opaque identity
  const copied: G.Ref<G.Type<typeof header>> = spread
  void copied
  return { h, body }
})

const s: G.Grammar<void> = G.gen(function*() {
  yield* G.literal("a")
})

// @ts-expect-error bare value grammar
G.seq(G.literal("a"), G.integer)

// @ts-expect-error integer is not silent
G.integer.pipe(G.as(1))

const s2: G.Grammar<void> = G.seq(G.literal("a"), G.optional(G.symbol("b").pipe(G.between("<", ">"))))

const voidChoice: G.Grammar<void> = G.choice([G.literal("a"), G.literal("b")])

// @ts-expect-error a choice needs at least one branch
G.choice([])
// @ts-expect-error unknown printing policy
G.choice([G.integer], { print: "checked" })
const choiceBranches = [G.integer, G.literal("x").pipe(G.as("x"))] as const
const choicePolicy: G.ChoiceOptions = { print: "roundTrip" }
const policyChoice: G.Grammar<number | "x"> = G.choice(choiceBranches, choicePolicy)
void policyChoice

const tagged = G.taggedChoice(
  "kind",
  [
    ["number", G.integer],
    [true, G.literal("x").pipe(G.as("x"))],
  ] as const,
)
const taggedValue: G.Type<typeof tagged> = { kind: true, value: "x" }
// @ts-expect-error the payload must match the selected tag
const wrongPayload: G.Type<typeof tagged> = { kind: "number", value: "x" }
void [taggedValue, wrongPayload]

const wordGrammar = G.regex(/[a-z]+/, "word")
// @ts-expect-error Grammar is invariant because printing consumes its value
const widenedGrammar: G.Grammar<unknown> = wordGrammar
// @ts-expect-error the interpreter node is private
void wordGrammar.node

// eslint-disable-next-line unicorn/no-thenable -- Verifies reserved then property typing.
const reservedHeader = G.literal("h").pipe(G.as({ then: "a" as const }))
G.gen(function*() {
  const value = yield* reservedHeader
  const body = yield* G.match(G.get(value, "then"), [["a", G.integer]] as const)
  return { value, body }
})

const mixedKind = G.choice([G.literal("n").pipe(G.as(1)), G.literal("s").pipe(G.as("1"))])
G.gen(function*() {
  const kind = yield* mixedKind
  // @ts-expect-error match must cover every selector literal
  const value = yield* G.match(kind, [[1, G.integer]] as const)
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
  voidChoice,
  widenedGrammar,
]

const plainTagged = G.regex(/a/, "a").pipe(
  G.transform({ decode: (v) => ({ kind: "plain" as const, v }), encode: (x) => x.v }),
)
const untagged = G.regex(/b/, "b").pipe(G.transform({ decode: (v) => ({ v }), encode: (x) => x.v }))
const misTagged = G.regex(/c/, "c").pipe(
  G.transform({ decode: (v) => ({ kind: "other" as const, v }), encode: (x) => x.v }),
)
G.dispatch("kind", [["plain", plainTagged]] as const)
G.dispatch(
  "kind",
  [
    ["plain", plainTagged],
    // @ts-expect-error case "b" has no kind field
    ["b", untagged],
  ] as const,
)
G.dispatch(
  "kind",
  [
    ["plain", plainTagged],
    // @ts-expect-error case "c" has kind "other", not "c"
    ["c", misTagged],
  ] as const,
)
const onGrammar = G.dispatch("kind", [["plain", plainTagged]] as const)
const onValue: G.Type<typeof onGrammar> = {
  kind: "plain",
  v: "a",
}
// @ts-expect-error the value must carry the case's tag
const onBad: G.Type<typeof onGrammar> = { kind: "other", v: "a" }
void onBad
void onValue

type Variant = { readonly kind: "a"; readonly n: 0 } | { readonly kind: "b"; readonly n: number }
const variant = G.struct({
  kind: G.choice([G.literal("a").pipe(G.as("a")), G.literal("b").pipe(G.as("b"))]),
  n: G.integer,
}).pipe(
  G.filter(
    (value: { readonly kind: "a" | "b"; readonly n: number }): value is Variant => value.kind === "b" || value.n === 0,
    "variant",
  ),
)
const merged = G.gen(function*() {
  const v = yield* variant
  const id = yield* G.integer
  return { v, id }
}).pipe(
  G.transform({
    decode: ({ v, id }) => ({ ...v, id }),
    encode: ({ id, ...v }) => ({ v, id }),
  }),
)
const mergedValue: G.Type<typeof merged> = { kind: "b", n: 42, id: 7 }
// @ts-expect-error kind "a" requires n to be 0
const mergedBad: G.Type<typeof merged> = { kind: "a", n: 42, id: 7 }
void mergedValue
void mergedBad
