# effect-grammar

Invertible grammar combinators and parser-printers for Effect.

Schema models your structured data. `effect-grammar` models the text formats
inside your strings: connection strings, duration strings (`1h30m`), cron
expressions, search queries, or DSLs.

You write the grammar definition once. You get four outputs:

- **A Parser**: Reads text and outputs structured data with line and column
  error messages.
- **A Printer**: Converts structured data back to canonical text.
- **A `Schema.Codec<A, string>`**: Integrates directly with Effect Schema
  (`decode` parses, `encode` prints, and Schema refinements compose).
- **A Text Renderer**: Formats the grammar as readable text for documentation
  and schema descriptions.

## Why effect-grammar?

- **`Schema.transformOrFail`**: Requires you to write and maintain both `decode`
  and `encode` functions manually.
- **`Schema.TemplateLiteralParser`**: Supports only flat `${a}-${b}` string
  patterns.
- **`effect-grammar`**: Automatically derives the parser and printer for formats
  with optional parts, repetition, alternation, and recursion.

This is for format strings, not documents. The parser backtracks with no
memoization and no left recursion. Printing is canonical, not pretty.

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

A silent grammar (`literal`, `symbol`, `whitespace`, anything under `skip`)
carries no value and can be `yield*`-ed bare. A value grammar goes through
`field(name, g)`.

`print` replays the generator. It reads each field from `value[name]` and passes
that back as the `yield*` result. An `if` on a parsed value takes the same path
both ways. The generator's return must hold every field under its name, and the
types enforce it. Return nothing and you get the object of fields.

`render` cannot read a generator. It runs the generator once with no values and
shows the parts it yields. The rendering is exact when the generator is
straight-line, as above. If the generator branches on a parsed value, render
still runs with no values. `if (kind === "a") yield* ...` shows only the path
`undefined` takes, with no warning. Put the branch in `choice` instead, which
renders every option.

`seq` is the same field object without generator control flow. It renders every
part:

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
first, then the target's refinements. Encoding prints.

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

`transform` maps a value both ways. `decodeTo` takes a Schema that types
`decode` and `encode` and checks the value on parse and on print. A `choice` of
Schema-typed branches picks the matching Schema when printing.

```ts
const Num = Schema.Struct({ kind: Schema.Literal("num"), value: Schema.Finite })
const num = Grammar.integer.pipe(
  Grammar.decodeTo(Num)({
    decode: (value) => ({ kind: "num", value }),
    encode: (n) => n.value,
  }),
)
```

`as` turns a silent grammar into a constant. `flag` turns presence into a
boolean:

```ts
const jsonNull = Grammar.symbol("null").pipe(Grammar.as(null))
const negate = Grammar.flag("-")
```

Recursion uses `suspend`:

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

`choice` backtracks. Errors report the furthest position the parser reached and
everything that could have matched there:

```
line 1, column 7: expected one of "null", "true", "false", number, string, "[", "{", found end of input
```

`label(name)` names a grammar for these messages.
