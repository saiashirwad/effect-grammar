# effect-grammar

Define a parser, printer, and Effect schema codec from one grammar.

```sh
npm install effect@rc effect-grammar
```

## Quick start

Parse and print endpoints in the form `https://host:port`:

```ts
import { Schema } from "effect"
import * as G from "effect-grammar"
import * as GrammarSchema from "effect-grammar/Schema"

const endpoint = G.gen(function*() {
  yield* G.literal("https://")
  const host = yield* G.regex(/[^:/?#]+/, "host")
  yield* G.literal(":")
  const port = yield* G.integer
  return { host, port }
})

const Endpoint = GrammarSchema.codec(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int,
  }),
)

Schema.decodeSync(Endpoint)("https://effect.website:443")
// { host: "effect.website", port: 443 }

Schema.encodeSync(Endpoint)({ host: "effect.website", port: 443 })
// "https://effect.website:443"
```
