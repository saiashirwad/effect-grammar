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
  with optional parts, repetition, alternation, recursion, and parts that depend
  on earlier parts.

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
  const host = yield* Grammar.regex(/[^:/?#]+/, "host")
  const port = yield* Grammar.optional(Grammar.prefix(":", Grammar.integer))
  return { host, port }
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

`gen` runs the generator once, when you build the grammar. Nothing is parsed
yet, so `yield*` on a value grammar does not return a value. It returns a
`Ref<A>`: a name for the value that will be there at parse and print time. A
silent grammar (`literal`, `symbol`, `whitespace`, anything under `skip`)
carries no value and returns nothing.

The generator's return is a pattern over those refs: a bare ref, a plain object,
an array, or constants around them. Parsing fills the pattern in. Printing reads
each ref back out of the value you give it. That is what makes the grammar
invertible without a `field` name for every part.

```ts
const nested = Grammar.gen(function* () {
  const host = yield* Grammar.regex(/[^:]+/, "host")
  yield* Grammar.literal(":")
  const port = yield* Grammar.integer
  return { kind: "endpoint", address: { host, port } } as const
})
// Grammar<{ kind: "endpoint"; address: { host: string; port: number } }>
```

Write `as const` for a tuple or a literal, as you would anywhere else.

Every binding must appear in the return exactly once, or `gen` throws when you
build it. A binding the return does not hold is a value the printer could not
print. To parse something and drop it, `skip` it: the grammar then prints its
canonical form.

A ref is not a value, so JavaScript cannot look at it. `port ?? 443` keeps the
ref; `kind === "num"` is a type error; interpolating one throws. Defaults and
other computation go in `transform`. Branching goes through `match`.

## Depending on an earlier part

`match` picks a grammar by the value of an earlier binding. The cases are keyed
by the literal's string form, so a boolean takes `{ true, false }`. The printer
runs the same choice backwards.

```ts
const tagged = Grammar.gen(function* () {
  const kind = yield* Grammar.choice(
    Grammar.literal("n:").pipe(Grammar.as("num")),
    Grammar.literal("w:").pipe(Grammar.as("word")),
  )
  const value = yield* Grammar.match(kind, {
    num: Grammar.integer,
    word: Grammar.regex(/[a-z]+/, "word"),
  })
  return { kind, value }
})
// n:12 → { kind: "num", value: 12 }
```

A property of a ref is a ref to that property, so a header parsed by one grammar
can steer the body in another:

```ts
const frame = Grammar.gen(function* () {
  const header = yield* headerGrammar // Ref<{ kind: "text" | "bin"; size: number }>
  yield* Grammar.literal(":")
  const body = yield* Grammar.match(header.kind, {
    text: Grammar.take(header.size),
    bin: Grammar.repeat(byte, header.size),
  })
  return { header, body }
})
```

`take(n)` reads exactly `n` characters and `repeat(g, n)` exactly `n`
repetitions. Both know how to get `n` back from what they parsed, so the count
need not be returned. A netstring is:

```ts
const netstring = Grammar.gen(function* () {
  const length = yield* Grammar.integer
  yield* Grammar.literal(":")
  const payload = yield* Grammar.take(length)
  yield* Grammar.literal(",")
  return payload
})
// "5:hello," ⇄ "hello"
```

A `match` whose scrutinee is not returned recovers it the way `choice` prints:
by trying each case in order. `dependent(refs, select, { recover, show })` is
the primitive under all three, for grammars that depend on values in ways these
do not cover.

`seq(...silents)` is a silent sequence with no bindings:
`seq(literal("NOT"), whitespace)`.

## The Schema

`toSchema` takes the grammar and the Schema it should decode to. Parsing happens
first, then the target's refinements. Encoding prints.

```ts
const Endpoint = Grammar.toSchema(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.UndefinedOr(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    ),
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

## Rendering

`render` walks the static grammar, so it is exact: every `gen` step, every
`choice` option, every `match` case. Bindings are named by their path in the
return; a recovered binding has no name and shows as `$n`.

```
"https://" host:<host> port:(":" <integer>)?
h:(kind:("t" | "b") size:<integer>) ":" body:match(h.kind){text => <char>{h.size} | bin => (<bit>){h.size}}
```

## Errors

`choice` backtracks. Errors report the furthest position the parser reached and
everything that could have matched there:

```
line 1, column 7: expected one of "null", "true", "false", number, string, "[", "{", found end of input
```

`label(name)` names a grammar for these messages.
