# effect-grammar

Effect Schema, but for text formats. One definition yields a parser, a printer,
a rendered grammar, and a `Schema<A, string>`.

## Install

```bash
pnpm add effect-grammar effect
```

Depends on Effect v4.

## Grammar

Define an HTTPS endpoint once, then parse it, print it, or derive a validated
Schema.

```ts
import { Schema } from "effect"
import { Grammar } from "effect-grammar"

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
Schema.decodeUnknownSync(Endpoint)("https://effect.website:443") // { host: "effect.website", port: 443 }
Schema.encodeSync(Endpoint)({ host: "effect.website", port: 443 }) // "https://effect.website:443"
```

## Parse-only with `Effect.gen`

Write plain Effect programs over the input. Custom errors are yielded failures.

```ts
import { Effect, Schema } from "effect"
import { char, digit, endOfInput, many, parse } from "effect-grammar/parser"

class OutOfRange extends Schema.TaggedErrorClass<OutOfRange>()("OutOfRange", {
  n: Schema.Finite,
}) {}

const byte = Effect.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 })
  const n = Number(digits.join(""))
  if (n > 255) return yield* new OutOfRange({ n })
  return n
})

const ip = Effect.gen(function* () {
  const a = yield* byte
  yield* char(".")
  const b = yield* byte
  yield* char(".")
  const c = yield* byte
  yield* char(".")
  const d = yield* byte
  yield* endOfInput
  return [a, b, c, d] as const
})

Effect.runSync(parse("192.168.1.1", ip))
// { _tag: "Success", value: [192, 168, 1, 1] }
```

Parsing is strict by default, so `parse` rejects trailing input. Use
`parsePrefix` when the input may contain content after the parsed value.

## Releasing

Add a changeset for a user-facing change:

```bash
pnpm changeset
```

After the change lands on `main`, the release workflow opens a version pull
request. Merging that pull request publishes the package to npm.
