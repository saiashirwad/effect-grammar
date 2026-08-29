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

Requires Effect `4.0.0-rc.112` or newer in the Effect 4 line.

## A grammar

```ts
import { Result, Schema } from "effect"
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
silent grammar (`literal`, `symbol`, `trivia`, anything under `skip`) carries no
value and returns nothing.

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

A ref is not a value, so JavaScript cannot look at it. `kind === "num"` is a
type error and interpolating a ref throws. Use `defaulted` for omitted values
and `match` for finite string literals. Use `when` for booleans, `matchValue`
for number or mixed literal keys, and `caseOf` for a partial runtime table.
Keys in `matchValue` retain their type, so `1` and `"1"` are distinct.

Property access is convenient for ordinary names. `get(ref, key)` also handles
reserved names such as `then`, `toJSON`, and `valueOf`.

## Depending on an earlier part

`match` picks a grammar from an exhaustive finite string union. The printer
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

`take(n)` reads exactly `n` UTF-16 code units and `repeat(g, n)` exactly `n`
repetitions. Both recover `n` from the value when printing, so the count need
not be returned. A netstring is:

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

A `match` whose scrutinee is not returned recovers it by trying each case in
order. Recovery continues through earlier recovered bindings until it reaches a
fixed point. Candidate assignments are isolated until the whole printer path
succeeds.

`dependent(refs, select, { recover, show })` handles other context-sensitive
grammars. `seq(...silents)` builds a silent sequence.

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

`transform` is for total partial isomorphisms. Its callbacks must not throw and
must satisfy both directions on accepted values. Use `transformOrFail` when
either direction can reject:

```ts
const jsonString = Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string").pipe(
  Grammar.transformOrFail({
    decode: (text) => Result.try({
      try: () => JSON.parse(text),
      catch: (error) => ({ message: String(error) }),
    }),
    encode: (value) => Result.succeed(JSON.stringify(value)),
  }),
)
```

`decodeTo` takes a Schema that types `decode` and `encode` and checks the value
on parse and print. `as` turns a silent grammar into a constant. `flag` turns
presence into a boolean.

General ordered `choice` has one round-trip law: text printed for a branch must
not parse through an earlier branch as a different value. Use `taggedChoice`
when the semantic result should record the chosen branch.

```ts
const value = Grammar.taggedChoice("kind", {
  number: Grammar.integer,
  word: Grammar.regex(/[a-z]+/, "word"),
})
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

## Products, delimiters, and trivia

`struct` and `tuple` build explicit products. Their staged form is the same
static sequence and output pattern that `gen` builds.

Delimiter combinators work data-first and data-last:

```ts
const port = Grammar.integer.pipe(
  Grammar.prefix(":"),
  Grammar.optional(),
  Grammar.defaulted(443),
)

const pair = Grammar.tuple(
  Grammar.integer,
  Grammar.integer.pipe(Grammar.prefix(",")),
)
```

`between` is the primary two-sided delimiter. `wrap` is its compatibility name.
`lexeme` consumes trailing `trivia` while printing no trivia. `symbol` is a
literal lexeme. `space` is one exact space; `spaces` accepts one or more
whitespace characters and prints one canonical space.

## Rendering

`describe` returns a short name. `render` walks the static grammar and includes
binding paths. Recovered refs use local deterministic names such as `$0`.
`toEBNF` returns `Result.fail(UnsupportedGrammar)` for context-sensitive nodes
instead of presenting them as context-free syntax.

The interpreter AST is private. Public grammars expose only the stable
`Grammar<A>`, `Ref<A>`, and combinator APIs.

## Errors

`choice` backtracks. Parse errors report the furthest position and every
expected form there. Print errors carry a `PrintIssue` tree with structural
paths, missing fields, branch failures, and mismatches. `PrintError.format`
renders that tree.
