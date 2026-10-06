import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const portNumber = Grammar.integer.pipe(Grammar.filter((n: number) => n >= 1 && n <= 65535, "a port from 1 to 65535"))

const endpoint = Grammar.gen(function*() {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.regex(/[^:/?#]+/, "host")
  const port = yield* portNumber.pipe(Grammar.prefix(":"), Grammar.optional)
  return { host, port }
})

const Endpoint = GrammarSchema.codec(endpoint, { identifier: "Endpoint" })

const decode = Schema.decodeEffect(Endpoint)
const encode = Schema.encodeEffect(Endpoint)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const source = "https://effect.website:443"

Effect.gen(function*() {
  const decoded = yield* decode(source)
  const encoded = yield* encode(decoded)
  const noPort = yield* decode("https://effect.website")

  yield* Console.log(`decode ${source}\n  →  ${json(decoded)}`)
  yield* Console.log(`encode ${json(decoded)}\n  →  ${encoded}`)
  yield* Console.log(`decode https://effect.website\n  →  ${json(noPort)}`)
}).pipe(Effect.runSync)
