# effect-grammar

Define a parser, printer, and Effect schema codec from one grammar.

## Install

Requires Node.js 20 or later and Effect `>=4.0.0-rc.112 <5`.

```sh
npm install effect@4.0.0-rc.112 effect-grammar
```

## Quick start

Parse and print endpoints in the form `https://host:port`:

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

`G.literal` matches fixed text. `G.gen` defines the fields to parse and print.

Encoding checks that the output parses back to an equal value using
`Equal.equals`. It does not preserve the original text's spelling. Pass
`{ roundTrip: "off" }` as the third argument to `G.codec` to skip this check.

## Parsing and printing without Schema

Use the grammar directly with `parse`, `print`, or `printChecked`. Each returns
an Effect `Result`:

```ts
import { Result } from "effect"

const parsed = G.parse(endpoint, "https://effect.website:443")

if (Result.isSuccess(parsed)) {
  console.log(parsed.success)
  // { host: "effect.website", port: 443 }
}

const invalid = G.parse(endpoint, "https://effect.website:nope")

if (Result.isFailure(invalid)) {
  console.error(invalid.failure)
  // ParseError
}

const printed = G.printChecked(endpoint, {
  host: "effect.website",
  port: 443,
})
// Result containing "https://effect.website:443"
```

`parse` requires the whole input to match. `print` prints without a round-trip
check. `printChecked` checks that the output parses back to an equal value.

Printing a `gen` object requires exactly its declared fields. Repeated items
must consume input. Empty matches fail rather than loop.

## Binary

Use `effect-grammar/Binary` to parse and print bytes with the same grammar
helpers. This header contains an 8-bit version and a big-endian 16-bit length:

```ts
import { Result } from "effect"
import * as G from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

const header = G.struct({
  version: Binary.uint8,
  length: Binary.uint16,
})

Result.getOrThrow(Binary.parse(header, Uint8Array.of(0x01, 0x00, 0x03)))
// { version: 1, length: 3 }

Result.getOrThrow(Binary.printChecked(header, { version: 1, length: 3 }))
// Uint8Array [1, 0, 3]
```

## Examples

- [Endpoint grammar](examples/endpoint.ts)
- [Length-prefixed text](examples/netstring.ts)
- [Schema errors](examples/schema-error.ts)
- [Printing behavior](examples/printing.ts)
- [Recursive Scheme syntax](examples/scheme.ts)
- [Binary DNS messages](examples/dns.ts)

See [`examples/`](examples/) for JSON, IP addresses, HTTP ranges, and more.
