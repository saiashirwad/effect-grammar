import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/index.ts"

const endpoint = Grammar.gen(function* () {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.regex(/[^:/?#]+/, "host")
  const port = yield* Grammar.optional(Grammar.prefix(":", Grammar.integer))
  return { host, port }
})

const Endpoint = Grammar.codec(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  }),
  { identifier: "Endpoint" },
)

const decode = Schema.decodeEffect(Endpoint)
const encode = Schema.encodeEffect(Endpoint)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const source = "https://effect.website:443"

Effect.gen(function* () {
  const decoded = yield* decode(source)
  const encoded = yield* encode(decoded)
  const noPort = yield* decode("https://effect.website")

  yield* Console.log(`grammar ${Grammar.render(endpoint)}`)
  yield* Console.log(`decode ${source}\n  →  ${json(decoded)}`)
  yield* Console.log(`encode ${json(decoded)}\n  →  ${encoded}`)
  yield* Console.log(`decode https://effect.website\n  →  ${json(noPort)}`)
}).pipe(Effect.runSync)
