# effect-grammar

Invertible grammar combinators and parser-printers for Effect.

Schema models structured data. `effect-grammar` models text formats inside
strings, such as connection strings, durations, cron expressions, search
queries, and DSLs.

Define a grammar once. You get:

- a parser from text to structured data
- a printer from structured data to canonical text
- a `Schema.Codec<A, string>`
- a readable text description of the grammar

## Install

```bash
pnpm add effect-grammar
```

Requires Effect `4.0.0-rc.112` or newer in the Effect 4 line.

## Parse and print with one grammar

This grammar reads two frame types. A text frame contains a string. A bits frame
contains a list of bits. The `kind` field selects the grammar for the body, and
the `size` field controls its length.

```ts
import * as Grammar from "effect-grammar"

const frame = Grammar.gen(function* () {
  const kind = yield* Grammar.choice(
    Grammar.literal("text").pipe(Grammar.as("text")),
    Grammar.literal("bits").pipe(Grammar.as("bits")),
  )
  yield* Grammar.literal("/")
  const size = yield* Grammar.integer
  yield* Grammar.literal(":")
  const body = yield* Grammar.match(kind, {
    text: Grammar.take(size),
    bits: Grammar.repeat(Grammar.regex(/[01]/, "bit"), size),
  })
  return { kind, size, body }
})
```

The same grammar parses both branches:

```text
parse "text/5:hello"
  → { "kind": "text", "size": 5, "body": "hello" }

parse "bits/4:1010"
  → { "kind": "bits", "size": 4, "body": ["1", "0", "1", "0"] }
```

It prints each value with the correct branch:

```text
print { kind: "text", size: 2, body: "hi" }
  → "text/2:hi"

print { kind: "bits", size: 4, body: ["1", "0", "1", "0"] }
  → "bits/4:1010"
```

Parse and print errors identify the failed text position or value path:

```text
parse "bits/4:1020"
  → line 1, column 10: expected bit, found "2"

print { kind: "text", size: 2, body: "hello" }
  → .body: expected 2 UTF-16 code units, got "hello"
```

`render` produces a description for documentation and Schema annotations:

```text
kind:("text" | "bits") "/" size:<integer> ":" body:match(kind){"text" => <char>{size} | "bits" => (<bit>){size}}
```

## How `gen` works

`gen` runs the generator once when you build the grammar. It does not parse text
at that time.

A value grammar produces a `Ref<A>` inside the generator. A ref represents the
value that will exist during parsing or printing. A silent grammar, such as
`literal` or `symbol`, does not produce a value.

The generator return value defines the result shape. Parsing fills that shape.
Printing reads the same fields to produce text.

Each binding must occur in the return value exactly once. `gen` reports an error
when a binding is missing or occurs more than once. Use `skip` when you must
parse and discard a value.

A ref is not a JavaScript value. Use `match` or `matchValue` to select a grammar
from a ref. You can also use a property of a ref, such as `header.kind` or
`header.size`. Use `get(ref, key)` for reserved property names.

`match` cases must cover all string literals in the selector type. The parser
and printer use the same selected branch.

## Schema integration

`toSchema` combines a grammar with an Effect Schema. Decoding parses the text
and then checks the value. Encoding checks the value and then prints it.

```ts
import { Schema } from "effect"

const FrameValue = Schema.Struct({
  kind: Schema.Literals(["text", "bits"]),
  size: Schema.Number,
  body: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
})

const Frame = Grammar.toSchema(frame, FrameValue, {
  identifier: "Frame",
})

const decode = Schema.decodeEffect(Frame)
const encode = Schema.encodeEffect(Frame)
```

See the [endpoint example](./examples/endpoint.ts) for a complete Schema.

## Main building blocks

| Purpose                     | Combinators                                              |
| --------------------------- | -------------------------------------------------------- |
| Text                        | `literal`, `regex`, `integer`, `take`, `repeat`          |
| Sequences and products      | `gen`, `seq`, `struct`, `tuple`                          |
| Delimiters                  | `prefix`, `suffix`, `between`, `wrap`                    |
| Repetition and options      | `optional`, `many`, `sepBy`                              |
| Alternatives                | `choice`, `taggedChoice`, `match`, `matchValue`          |
| Value conversion            | `transform`, `transformOrFail`, `decodeTo`, `as`, `flag` |
| Defaults and ignored values | `defaulted`, `skip`                                      |
| Whitespace                  | `lexeme`, `symbol`, `space`, `spaces`, `trivia`          |
| Recursion                   | `suspend`                                                |

Most delimiter and repetition combinators support data-first and data-last
calls, so they also work with `pipe`.

## Results, errors, and rendering

`parse` and `print` return `Result` values. Parse errors report the furthest
text position, the expected forms, and the line and column. Print errors contain
a `PrintIssue` tree with paths, missing fields, failed branches, and value
mismatches. `PrintError.format` converts that tree to text.

`render` describes a complete grammar. `describe` returns a short grammar name.

## More examples

- [Postgres connection string](./examples/connection-string.ts): optional parts,
  query parameters, Schema checks, encoding, and round trips
- [JSON](./examples/json.ts): a recursive grammar and Schema codec
- [Scheme](./examples/scheme.ts): recursive expressions, tokens, and canonical
  whitespace
- [GitHub search](./examples/github-search.ts): a larger search-query DSL
- [IP address](./examples/ip.ts): transforms and Schema refinements
- [Printing showcase](./examples/printing.ts): parsing, printing, rendering, and
  print failures
