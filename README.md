# effect-grammar

effect-grammar lets you define composable, bidirectional grammars and use them
to derive Effect Schema codecs.

```sh
npm i effect-grammar
```

```ts
import { Schema } from "effect"
import * as G from "effect-grammar"

const endpoint = G.gen(function* () {
  yield* G.literal("https://")
  const host = yield* G.regex(/[^:/?#]+/, "host")
  yield* G.literal(":")
  const port = yield* G.integer
  return { host, port }
})

const Endpoint = G.codec(
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
