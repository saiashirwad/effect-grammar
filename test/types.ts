/**
 * Type-level guarantees. Every `@ts-expect-error` below must be a real error —
 * `pnpm typecheck` fails on an unused directive.
 */
import { Grammar as G } from "../src/index.ts"

// A value grammar cannot be yielded bare: the printer would have nothing to print it from.
G.gen(function* () {
  // @ts-expect-error wrap it in field("name", ...)
  const s = yield* G.regex(/x/, "x")
  return { s }
})

// The returned object must hold every field under its name.
// @ts-expect-error missing "host"
G.gen(function* () {
  const host = yield* G.field("host", G.regex(/x/, "x"))
  return { hostname: host }
})

// ...with the field's type.
// @ts-expect-error port is number | undefined
G.gen(function* () {
  const port = yield* G.field("port", G.optional(G.integer))
  return { port: String(port) }
})

// seq only accepts silent grammars and fields.
// @ts-expect-error bare value grammar
G.seq(G.literal("a"), G.integer)

// `as` only applies to silent grammars.
// @ts-expect-error integer is not silent
G.integer.pipe(G.as(1))

// The value type is exactly the generator's return type...
const g = G.gen(function* () {
  yield* G.literal("(")
  const n = yield* G.field("n", G.integer)
  const tags = yield* G.field("tags", G.many(G.regex(/[a-z]+/, "tag")))
  yield* G.literal(")")
  return { n, tags }
})
const ok: G.Type<typeof g> = { n: 1, tags: ["a"] }
// @ts-expect-error n must be a number
const bad: G.Type<typeof g> = { n: "1", tags: [] }

// ...or the object of fields when there is no return.
const g2 = G.gen(function* () {
  yield* G.literal("(")
  yield* G.field("n", G.integer)
})
const ok2: G.Type<typeof g2> = { n: 1 }

// A conditional grammar yields the union of both value types.
const g3 = G.gen(function* () {
  const kind = yield* G.field("kind", G.flag("#"))
  const value = yield* G.field("value", kind ? G.integer : G.regex(/x/, "x"))
  return { kind, value }
})
const ok3: G.Type<typeof g3> = { kind: true, value: 1 }
const ok3b: G.Type<typeof g3> = { kind: false, value: "x" }

// Silent composition stays silent.
const s: G.Silent = G.seq(G.literal("a"), G.optional(G.wrap("<", G.symbol("b"), ">")))

// A silent choice is not silent (it has no canonical print).
// @ts-expect-error
const notSilent: G.Silent = G.choice(G.literal("a"), G.literal("b"))

void [ok, bad, ok2, ok3, ok3b, s, notSilent]
