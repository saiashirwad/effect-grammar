# effect-grammar

Schema for the inside of a string.

You model your domain with Effect Schema. Some of those values also have a text
form — a connection string, `1h30m`, a cron line, a search query, an
S-expression. `effect-grammar` lets you write that format once, as a grammar,
and derive everything else from it:

- a parser with line/column errors that say what was expected,
- a printer that emits the canonical text for a value,
- a `Schema.Codec<A, string>` wiring both into `decode` and `encode`, so Schema
  refinements compose with the grammar,
- `render`, the grammar as text, used as the Schema's description.

Effect's `Schema.transformOrFail` gives you the frame and leaves both functions
to you; `Schema.TemplateLiteralParser` handles flat `${a}-${b}` patterns only.
This fills the gap between the two for formats with optional parts, repetition,
alternation, and recursion.

Scope: format strings, not documents. The parser backtracks freely without
memoisation, there is no left recursion, and printing is canonical, not pretty.

## Install

```bash
pnpm add effect-grammar
```

Depends on Effect v4. The package pins `effect` to `4.0.0-beta.102` for now.

## A grammar

```ts
import { Schema } from "effect"
import * as Grammar from "effect-grammar"

const endpoint = Grammar.gen(function* () {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.field("host", Grammar.regex(/[^:/?#]+/, "host"))
  const port = yield* Grammar.field(
    "port",
    Grammar.optional(Grammar.prefix(":", Grammar.integer)),
  )
  return { host, port: port ?? 443 }
})

Grammar.parse(endpoint, "https://effect.website:8080")
// Result.succeed({ host: "effect.website", port: 8080 })
Grammar.parse(endpoint, "https://effect.website:abc")
// Result.fail(ParseError: line 1, column 24: expected integer, found "a")
Grammar.print(endpoint, { host: "effect.website", port: 443 })
// Result.succeed("https://effect.website:443")
Grammar.render(endpoint)
// "https://" host:<host> port:(":" <integer>)?
```

The rule that makes a generator printable: a **silent** grammar (`literal`,
`symbol`, `whitespace`, anything under `skip`) carries no value and can be
`yield*`-ed bare. A **value** grammar goes through `field(name, g)`. Printing
replays the generator, reading each field from `value[name]` and feeding it back
in, so an `if` on a parsed value takes the same path in both directions. The
generator's return must hold every field under its name — the types enforce it —
or return nothing and get the object of fields.

`seq` is the same thing without control flow, and renders exactly:

```ts
const member = Grammar.seq(
  Grammar.field("key", jsonString),
  Grammar.symbol(":"),
  Grammar.field("value", jsonValue),
)
// Grammar<{ key: string; value: Json }>
```

## The Schema

`toSchema` takes the grammar and the Schema it should decode to. Parsing happens
first, then the target's refinements; encoding prints.

```ts
const Endpoint = Grammar.toSchema(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  { identifier: "Endpoint" },
)

Schema.decodeUnknownSync(Endpoint)("https://effect.website:443")
// { host: "effect.website", port: 443 }
Schema.encodeSync(Endpoint)({ host: "effect.website", port: 443 })
// "https://effect.website:443"
```

## Values and alternatives

`transform` maps a value both ways. `decodeTo` does the same with a Schema as
the contract: the Schema types `decode`/`encode` and guards both directions, so
a `choice` of Schema-typed branches picks the right one when printing.

```ts
const Num = Schema.Struct({ kind: Schema.Literal("num"), value: Schema.Finite })
const num = Grammar.integer.pipe(
  Grammar.decodeTo(Num)({
    decode: (value) => ({ kind: "num", value }),
    encode: (n) => n.value,
  }),
)
```

Constants come from silent grammars with `as`; presence becomes a boolean with
`flag`:

```ts
const jsonNull = Grammar.symbol("null").pipe(Grammar.as(null))
const negate = Grammar.flag("-")
```

Recursion goes through `suspend`:

```ts
const jsonValue: Grammar.Grammar<Json> = Grammar.suspend(
  () =>
    Grammar.choice(
      jsonNull,
      jsonBool,
      jsonNumber,
      jsonString,
      jsonArray,
      jsonObject,
    ),
  "value",
)
```

See `examples/` for JSON, Scheme, a Postgres DSN, netstrings, and GitHub's
search syntax.

## Errors

`choice` backtracks fully. Errors report the furthest position the parser
reached and everything that could have matched there:

```
line 1, column 7: expected one of "null", "true", "false", number, string, "[", "{", found end of input
```

`label(name)` names a grammar for these messages.
