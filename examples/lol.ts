import { Console, Effect, Result, Schema } from "effect"

import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

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

const header = G.gen(function*() {
  const kind = yield* G.literals("raw", "pair")
  yield* G.literal(":")
  const size = yield* G.integer.pipe(G.filter((n: number) => n >= 0 && n <= 16, "a size from 0 to 16"))
  return { kind, size }
})

const frame = G.gen(function*() {
  const h = yield* header
  yield* G.literal("#")
  const body = yield* G.match(
    G.get(h, "kind"),
    [
      ["raw", G.take(G.get(h, "size"))],
      [
        "pair",
        G.gen(function*() {
          const name = yield* G.regex(/[a-z]+/, "name")
          yield* G.literal("=")
          const value = yield* G.take(G.get(h, "size"))
          return { name, value }
        }),
      ],
    ] as const,
  )
  return { h, body }
})

const Frame = GrammarSchema.codec(frame, { identifier: "Frame" })

Effect.gen(function*() {
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
    "decode ✗",
    attempt(() => json(Schema.decodeSync(Frame)(`raw:99#${"x".repeat(99)}`))),
  )
  yield* Console.log()
  yield* Console.log(
    "encode ✗",
    attempt(() => Schema.encodeSync(Frame)({ h: { kind: "raw", size: 5 }, body: "hi" })),
  )
}).pipe(Effect.runFork)
