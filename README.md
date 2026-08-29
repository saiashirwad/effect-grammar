# effect-grammar

Invertible grammar combinators and parser-printers for Effect.

Schema models your structured data. `effect-grammar` models the text formats
inside your strings: connection strings, duration strings (`1h30m`), cron
expressions, search queries, or DSLs.

You write the grammar definition once. You get four outputs:

- **A parser.** Reads text and outputs structured data, with line and column
  error messages.
- **A printer.** Converts structured data back to canonical text.
- **A `Schema.Codec<A, string>`.** Decoding parses, encoding prints, and Schema
  refinements compose.
- **A text renderer.** Formats the grammar as readable text, for documentation
  and schema descriptions.

## Why effect-grammar?

`Schema.transformOrFail` makes you write and maintain both directions by hand.
`Schema.TemplateLiteralParser` only handles flat `${a}-${b}` patterns.
`effect-grammar` derives both directions for you. It handles optional parts,
repetition, alternation, recursion, and parts that depend on earlier parts.

This is for format strings, not documents. The parser backtracks. There is no
memoization and no left recursion. Printing is canonical, not pretty.

## Install

```bash
pnpm add effect-grammar
```

Requires Effect `4.0.0-rc.112` or newer in the Effect 4 line.

## A grammar

```ts
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
yet.

Inside the generator, `yield*` on a value grammar does not give you a value. It
gives you a `Ref<A>`: a stand-in for the value that will exist at parse and
print time. `yield*` on a silent grammar, such as `literal` or `symbol`, gives
nothing back. Silent grammars carry no value.

The generator's return value is a pattern over those refs. It can be a bare ref,
an object, an array, or constants around them. Parsing fills the pattern in.
Printing reads each ref back out of the value you hand it. That is what makes
the grammar invertible.

```ts
const nested = Grammar.gen(function* () {
  const host = yield* Grammar.regex(/[^:]+/, "host")
  yield* Grammar.literal(":")
  const port = yield* Grammar.integer
  return { kind: "endpoint", address: { host, port } } as const
})
// Grammar<{ kind: "endpoint"; address: { host: string; port: number } }>
```

## The one rule

Every binding must appear in the return pattern exactly once. `gen` throws at
build time if one does not. A binding the return does not hold is a value the
printer could not print.

To parse something and then drop it, wrap it with `skip`. The grammar prints its
canonical form instead.

## Refs are not values

A ref is a stand-in, so JavaScript cannot look inside it. Comparing a ref with
`===` is a type error. Interpolating one into a string throws.

Branching on a ref is `match`, described below. For everything else there are
small helpers: `defaulted` supplies a value when a part is absent.
`get(ref, key)` reads a property of a ref, including reserved names such as
`then` and `toJSON`.

## Depending on an earlier part

`match` picks a grammar based on an earlier binding. The printer runs the same
choice backwards.

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
// parses "n:12"  →  { kind: "num", value: 12 }
```

`match` requires the cases to cover every literal of the selector's type.
`matchValue` is the same idea with number or mixed literal keys. Keys keep their
type, so `1` and `"1"` are distinct cases.

A property of a ref is a ref to that property. A header parsed by one grammar
can steer the body of another:

```ts
const frame = Grammar.gen(function* () {
  const header = yield* headerGrammar // { kind: "text" | "bin"; size: number }
  yield* Grammar.literal(":")
  const body = yield* Grammar.match(header.kind, {
    text: Grammar.take(header.size),
    bin: Grammar.repeat(Grammar.regex(/[01]/, "bit"), header.size),
  })
  return { header, body }
})
```

`take(n)` reads exactly `n` characters (UTF-16 code units). `repeat(g, n)` reads
exactly `n` repetitions. The count is a value like any other: return it, and
printing reads it back. A netstring is:

```ts
const netstring = Grammar.gen(function* () {
  const length = yield* Grammar.integer
  yield* Grammar.literal(":")
  const payload = yield* Grammar.take(length)
  yield* Grammar.literal(",")
  return { length, payload }
})
// "5:hello,"  ⇄  { length: 5, payload: "hello" }
```

`seq(...silents)` builds a silent sequence.

## Values and alternatives

`transform` maps between two types, in both directions. Write plain functions.
If a callback throws, the grammar fails cleanly. Use `transformOrFail` when a
direction should return a `Result` instead:

```ts
const jsonString = Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string").pipe(
  Grammar.transformOrFail({
    decode: (text) =>
      Result.try({
        try: () => JSON.parse(text),
        catch: (error) => ({ message: String(error) }),
      }),
    encode: (value) => Result.succeed(JSON.stringify(value)),
  }),
)
```

`decodeTo` checks the value against a Schema on parse and on print. `as` turns a
silent grammar into a constant. `flag` turns presence into a boolean.

`choice` tries its options in order and backtracks. It has one round-trip rule:
the text printed for a branch must not parse as a different value through an
earlier branch. `taggedChoice` records the chosen branch in the result.

```ts
const value = Grammar.taggedChoice("kind", {
  number: Grammar.integer,
  word: Grammar.regex(/[a-z]+/, "word"),
})
// parses "12"      →  { kind: "number", value: 12 }
// prints the same  →  "12"
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

See `examples/` for JSON, Scheme, a Postgres DSN, netstrings, a wire protocol,
and GitHub's search syntax.

## Products, delimiters, and trivia

`struct` and `tuple` build products without a generator. Their staged form is
the same as what `gen` builds.

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

`between` is the two-sided delimiter. `wrap` is another name for it. `lexeme`
skips trailing whitespace after a token, and prints none. `symbol` is a literal
lexeme. `space` is one exact space. `spaces` accepts one or more whitespace
characters and prints one canonical space.

## Rendering

`render` formats a grammar as readable text, including binding paths. `describe`
returns a short name for a grammar.

The interpreter AST is private. Public grammars expose only `Grammar<A>`,
`Ref<A>`, and the combinators.

## Errors

Parse errors report the furthest position reached, with every expected form at
that position, plus line and column.

Print errors carry a `PrintIssue` tree. It records structural paths, missing
fields, branch failures, and value mismatches. `PrintError.format` renders the
tree as text.
