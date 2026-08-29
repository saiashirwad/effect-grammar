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
import { Schema } from "effect"
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

const FrameValue = Schema.Struct({
  kind: Schema.Literals(["text", "bits"]),
  size: Schema.Number,
  body: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
})

const Frame = Grammar.toSchema(frame, FrameValue, { identifier: "Frame" })
const decode = Schema.decodeSync(Frame)
const encode = Schema.encodeSync(Frame)
```

The grammar and its Schema codec use the same parser and printer:

```text
decode("text/5:hello") → {"kind":"text","size":5,"body":"hello"}
decode("bits/4:1010") → {"kind":"bits","size":4,"body":["1","0","1","0"]}
encode({kind:"text",size:2,body:"hi"}) → "text/2:hi"
encode({kind:"bits",size:4,body:["1","0","1","0"]}) → "bits/4:1010"
parse("bits/4:1020") → line 1, column 10: expected bit, found "2"
print({kind:"text",size:2,body:"hello"}) → .body: expected 2 UTF-16 code units, got "hello"
render(frame) → kind:("text" | "bits") "/" size:<integer> ":" body:match(kind){"text" => <char>{size} | "bits" => (<bit>){size}}
```

## Schema integration

`toSchema` combines a grammar with an Effect Schema. Decoding parses the text
and then checks the value. Encoding checks the value and then prints it. The
example above shows the full integration in one code block.

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
