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
    G.literal("t:").pipe(G.as("text")),
    G.literal("b:").pipe(G.as("bits")),
  )
  const size = yield* G.integer
  return { kind, size }
})

const bit = G.regex(/[01]/, "bit")

const frame = G.gen(function* () {
  const h = yield* header
  yield* G.literal("#")
  const body = yield* G.match(h.kind, {
    text: G.take(h.size),
    bits: G.repeat(bit, h.size),
  })
  return { h, body }
})

const Frame = G.toSchema(
  frame,
  Schema.Struct({
    h: Schema.Struct({
      kind: Schema.Union([Schema.Literal("text"), Schema.Literal("bits")]),
      size: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    }),
    body: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  }),
  { identifier: "Frame" },
)

Effect.gen(function* () {
  yield* Console.log("parse  :", show(G.parse(frame, "t:3#abc")))
  yield* Console.log("decode :", json(yield* Schema.decodeEffect(Frame)("t:3#abc")))
  yield* Console.log("parse ", show(G.parse(frame, "t:x#abc")))
  yield* Console.log(
    "decode ",
    attempt(() => json(Schema.decodeSync(Frame)("t:x#abc"))),
  )
  yield* Console.log(
    "refine ",
    attempt(() => json(Schema.decodeSync(Frame)("b:4#1010"))),
  )
}).pipe(Effect.runFork)
