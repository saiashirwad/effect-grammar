import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/grammar.ts"

const endpoint = Grammar.map(
  Grammar.struct({
    scheme: Grammar.literal("https://"),
    host: Grammar.label("host", Grammar.regex(/[^:/?#]+/, "host")),
    portPart: Grammar.optional(
      Grammar.struct({ sep: Grammar.literal(":"), port: Grammar.integer }),
    ),
  }),
  {
    to: ({ host, portPart }) => ({ host, port: portPart?.port ?? 443 }),
    from: ({ host, port }) => ({
      scheme: "https://" as const,
      host,
      portPart: { sep: ":" as const, port },
    }),
  },
)
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

Effect.runSync(Console.log(`decode ${source}\n  →  ${JSON.stringify(decoded)}`))
Effect.runSync(Console.log(`encode ${JSON.stringify(decoded)}\n  →  ${encoded}`))
