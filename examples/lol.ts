import { Console, Effect, Result, Schema } from "effect"

import * as G from "../src/index.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const show = <A>(result: Result.Result<A, { readonly message: string }>) =>
  Result.match(result, {
    onSuccess: (value) => json(value),
    onFailure: ({ message }) => message,
  })

const attempt = (run: () => string): string => {
  try {
    return run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const header = G.gen(function* () {
  const kind = yield* G.choice(
    G.literal("raw:").pipe(G.as("raw")),
    G.literal("pair:").pipe(G.as("pair")),
  )
  const size = yield* G.integer
  return { kind, size }
})

const frame = G.gen(function* () {
  const h = yield* header
  yield* G.literal("#")
  const body = yield* G.match(h.kind, {
    raw: G.take(h.size),
    pair: G.gen(function* () {
      const name = yield* G.regex(/[a-z]+/, "name")
      yield* G.literal("=")
      const value = yield* G.take(h.size)
      return { name, value }
    }),
  })
  return { h, body }
})

const Frame = G.codec(
  frame,
  Schema.Struct({
    h: Schema.Struct({
      kind: Schema.Union([Schema.Literal("raw"), Schema.Literal("pair")]),
      size: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
    }),
    body: Schema.Union([
      Schema.String,
      Schema.Struct({ name: Schema.String, value: Schema.String }),
    ]),
  }),
  { identifier: "Frame" },
)

Effect.gen(function* () {
  yield* Console.log("grammar :", G.render(frame))
  yield* Console.log()
  yield* Console.log("parse   :", show(G.parse(frame, "raw:5#hello")))
  yield* Console.log()
  yield* Console.log("parse   :", show(G.parse(frame, "pair:5#user=alice")))
  yield* Console.log()
  yield* Console.log(
    "print   :",
    show(G.print(frame, { h: { kind: "pair", size: 5 }, body: { name: "user", value: "alice" } })),
  )
  yield* Console.log()
  yield* Console.log("parse ✗ ", show(G.parse(frame, "raw:x#hello")))
  yield* Console.log()
  yield* Console.log("decode  :", json(yield* Schema.decodeEffect(Frame)("pair:5#user=alice")))
  yield* Console.log()
  yield* Console.log(
    "refine ✗",
    attempt(() => json(Schema.decodeSync(Frame)(`raw:99#${"x".repeat(99)}`))),
  )
}).pipe(Effect.runFork)
