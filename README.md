# effect-grammar

```bash
pnpm add effect-grammar
```

Invertible grammar combinators and parser-printers for Effect.

A `Grammar<A>` supports four operations:

- `parse`: read a string and return a `Result<A, ParseError>`
- `print`: write an `A` as canonical text and return a
  `Result<string, PrintError>`
- `toSchema`: combine the grammar with an Effect Schema to make a string codec
- `render`: return a readable description of the grammar

```ts
import { Schema } from "effect"
import * as G from "effect-grammar"

const frame = G.gen(function* () {
  const kind = yield* G.choice(
    G.literal("text").pipe(G.as("text")),
    G.literal("bits").pipe(G.as("bits")),
  )
  yield* G.literal("/")
  const size = yield* G.integer
  yield* G.literal(":")
  const body = yield* G.match(kind, {
    text: G.take(size),
    bits: G.repeat(G.regex(/[01]/, "bit"), size),
  })
  return { kind, size, body }
})

const FrameValue = Schema.Struct({
  kind: Schema.Literals(["text", "bits"]),
  size: Schema.Number,
  body: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
})

const Frame = G.toSchema(frame, FrameValue, { identifier: "Frame" })
const decode = Schema.decodeSync(Frame)
const encode = Schema.encodeSync(Frame)
```

The grammar and its Schema codec use the same parser and printer:

```text
decode("text/5:hello") → { kind: "text", size: 5, body: "hello" }
decode("bits/4:1010") → { kind: "bits", size: 4, body: ["1", "0", "1", "0"] }

encode({ kind: "text", size: 2, body: "hi" }) → "text/2:hi"
encode({ kind: "bits", size: 4, body: ["1", "0", "1", "0"] }) → "bits/4:1010"

parse("bits/4:1020") → line 1, column 10: expected bit, found "2"
print({ kind: "text", size: 2, body: "hello" }) → .body: expected 2 UTF-16 code units, got "hello"

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
