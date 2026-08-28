import { Console, Effect, Schema } from "effect"

import { Grammar } from "../src/index.ts"

const endpoint = Grammar.gen(function* () {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.field("host", Grammar.regex(/[^:/?#]+/, "host"))
  const port = yield* Grammar.field("port", Grammar.optional(Grammar.prefix(":", Grammar.integer)))
  return { host, port: port ?? 443 }
})

const Endpoint = Grammar.toSchema(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  { identifier: "Endpoint" },
)

const source = "https://effect.website:443"
const decoded = Schema.decodeUnknownSync(Endpoint)(source)
const encoded = Schema.encodeSync(Endpoint)(decoded)

Effect.runSync(Console.log(`grammar ${Grammar.render(endpoint)}`))
Effect.runSync(Console.log(`decode ${source}\n  →  ${JSON.stringify(decoded)}`))
Effect.runSync(Console.log(`encode ${JSON.stringify(decoded)}\n  →  ${encoded}`))
Effect.runSync(
  Console.log(
    `decode https://effect.website\n  →  ${JSON.stringify(Schema.decodeUnknownSync(Endpoint)("https://effect.website"))}`,
  ),
)
