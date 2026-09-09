# effect-grammar

```bash
pnpm add effect-grammar
```

Invertible grammar combinators and parser-printers for Effect.

A `Grammar<A>` supports these operations:

- `parse`: read a string (or bytes, via `effect-grammar/Binary`) and return a
  `Result<A, ParseError>`
- `print`: write an `A` as canonical text and return a
  `Result<string, PrintError>`. Whitespace you skipped while parsing is not
  kept; `print` gives one fixed form.
- `printChecked`: `print`, then parse the output back and fail unless it reads
  as an equal value. The whole-grammar round-trip guarantee.
- `codec`: combine the grammar with an Effect Schema to make a string (or
  `Uint8Array`) codec
- `render`: return a readable description of the grammar
- `validate` / `compile`: check a grammar for staged errors before use

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

const Frame = G.codec(frame, FrameValue, { identifier: "Frame" })
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

`codec` combines a grammar with an Effect Schema. Decoding parses the text and
then checks the value. Encoding checks the value, prints it, and by default
parses the output back to confirm it decodes to the same value, so a codec never
encodes a valid value into text that decodes as another. Pass
`{ roundTrip: "off" }` to skip that check. The example above shows the full
integration in one code block.

See the [endpoint example](./examples/endpoint.ts) for a complete Schema.

## Binary input

`effect-grammar/Binary` parses and prints `Uint8Array` values, including Node.js
`Buffer`s. Binary primitives compose with the structural combinators (`gen`,
`choice`, `many`, `between`, and so on), and a length field can be derived from
the payload so values need not carry it:

```ts
import { Result } from "effect"
import * as G from "effect-grammar"
import * as B from "effect-grammar/Binary"

const encoder = new TextEncoder()
const message = G.gen(function* () {
  yield* B.literal([0xca, 0xfe])
  const length = yield* B.varuint
  const text = yield* B.utf8(length)
  yield* G.derive(
    length,
    G.mapRef(text, (value) => encoder.encode(value).length),
  )
  return { text }
})

const compiled = B.compile(message)
Result.getOrThrow(compiled.parse(new Uint8Array([0xca, 0xfe, 2, 0x68, 0x69])))
// { text: "hi" }
Result.getOrThrow(compiled.printChecked({ text: "hi" }))
// Uint8Array([0xca, 0xfe, 2, 0x68, 0x69])
```

| Primitive                               | Value        | Behavior                                               |
| --------------------------------------- | ------------ | ------------------------------------------------------ |
| `B.literal(bytes)`                      | `void`       | Match and print exact bytes                            |
| `B.uint8` (alias `B.byte`) / `B.int8`   | `number`     | 8-bit integers                                         |
| `B.be.uint16` … `B.le.float64`          | `number`     | 16/32-bit integers, 32/64-bit floats, by byte order    |
| `B.be.uint64` / `B.be.int64` (and `le`) | `bigint`     | 64-bit integers                                        |
| `B.varuint` / `B.varint`                | `number`     | LEB128, zigzag for signed, safe-integer range          |
| `B.bytes(count)`                        | `Uint8Array` | Exactly `count` bytes; static or `Ref<number>`         |
| `B.utf8(count)`                         | `string`     | Exactly `count` bytes of UTF-8                         |
| `B.bitfield(word, { a: 3, b: 5 })`      | `{ a, b }`   | Named bit fields of an integer, most significant first |

`B.parse`, `B.print`, `B.printChecked`, `B.validate`, `B.compile`, and `B.codec`
mirror the text operations; `B.codec` makes a `Schema.Uint8Array` codec. For the
round-trip laws, bind the testing helpers to the binary format:

```ts
import { lawsFor } from "effect-grammar/testing"

const { assertPrintParse, checkPrintParse } = lawsFor(B.format)
```

`B.ParseError` (tagged `BinaryParseError`) reports a zero-based byte `pos` and
the `found` byte. A `Grammar<A>` does not say which input it reads, so
`B.compile` (and `G.compile`) reject terminals of the other kind up front.
Fields are byte-aligned: `bitfield` splits one integer, and there is no
streaming. See the [binary message example](./examples/binary.ts).

## Main building blocks

| Purpose                         | Combinators                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Text                            | `literal`, `literals`, `regex`, `integer`, `take`, `repeat`                   |
| Bytes (`effect-grammar/Binary`) | `literal`, `byte`, `be`/`le`, `varuint`, `bytes`, `utf8`, `bitfield`          |
| Sequences and products          | `gen`, `seq`, `struct`, `tuple`                                               |
| Delimiters                      | `prefix`, `suffix`, `between`, `wrap`                                         |
| Repetition and options          | `optional`, `many`, `sepBy`                                                   |
| Alternatives                    | `choice`, `checkedChoice`, `choiceOn`, `taggedChoice`, `match`, `matchValue`  |
| Value conversion                | `transform`, `transformOrFail`, `iso`, `partialIso`, `decodeTo`, `as`, `flag` |
| Defaults and ignored values     | `defaulted`, `skip`                                                           |
| Whitespace                      | `lexeme`, `symbol`, `space`, `spaces`, `trivia`                               |
| Recursion                       | `suspend`                                                                     |

Most delimiter and repetition combinators support data-first and data-last
calls, so they also work with `pipe`.

`literals("GET", "POST")` parses and prints either string and has the value type
`"GET" | "POST"`. It requires at least one alternative and tries them in order,
like `choice`; put longer strings first when they share a prefix.

## Refs are names, not values

Inside `gen`, `yield*` gives you a `Ref<A>`, not an `A`. The generator runs
once, while the grammar is built, before any text exists. A ref stands for "the
value this step will parse or print". Use it only where a combinator accepts
one:

- `match(ref, cases)` and `matchValue(ref, entries)` choose a grammar by a
  parsed value
- `take(ref)`, `repeat(grammar, ref)`, and `B.bytes(ref)` read a count (each
  also accepts a static number)
- `mapRef(ref, f)` is a ref to `f` of its value, for counts that need arithmetic
  such as a length in words
- `derive(target, source)` declares that a binding equals another expression:
  parsing and printing check it, and printing computes the binding when the
  value leaves it out, so length prefixes and checksums stay out of your values
  (see the [netstring example](./examples/netstring.ts))
- return it, whole, from the generator

TypeScript rejects `ref === "x"`, `switch (ref)`, and `ref + 1`. Converting a
ref to a string throws. What nothing can catch is a truthiness test: `if (ref)`
is always true and `if (!ref)` is always false, so a step inside either runs
always or never. Branch with `match` instead:

```ts
const verbose = yield * G.flag("-v")
const detail =
  yield *
  G.matchValue(verbose, [
    [true, G.prefix(" ", G.integer)],
    [false, G.empty],
  ])
```

## Printing a choice

Parsing a `choice` is easy: the text decides. Printing has only the value, and
`choice` tries each branch in order and keeps the first whose printer accepts.
That goes wrong when an early branch's `encode` accepts values that belong to a
later one. Here `plain` prints `{ kind: "hashed", value: "x" }` as `x`, not
`#x`:

```ts
const plain = word.pipe(
  G.transform({
    decode: (value) => ({ kind: "plain", value }),
    encode: (v) => v.value,
  }),
)
const hashed = G.prefix("#", word).pipe(
  G.transform({
    decode: (value) => ({ kind: "hashed", value }),
    encode: (v) => v.value,
  }),
)
G.choice(plain, hashed)
```

Three ways out, from most to least specific:

- `choiceOn(tag, cases)` reads one field of the value and prints with the case
  of that name. Parsing tries the cases in order. TypeScript checks that each
  case yields a value whose `tag` is its key. No guards, no trial:

  ```ts
  G.choiceOn("kind", { plain, hashed })
  ```

  Pass an array of `[key, grammar]` entries for an explicit parse order and for
  number or boolean discriminants; the object form rejects integer-like keys,
  which JavaScript reorders:

  ```ts
  G.choiceOn("kind", [
    ["plain", plain],
    ["hashed", hashed],
  ] as const)
  ```

  `taggedChoice` is `choiceOn` for values shaped `{ [tag]: key, value }`. The
  tag name cannot be `"value"`, which is reserved for the branch payload.
  `choiceOn` fixes printer dispatch; it does not remove parse ambiguity, so two
  branches may still parse the same text.

- `checkedChoice(...branches)` prints with the first branch whose text parses
  back to an equal value. It reparses at every nested choice, so keep it off hot
  paths.

- `printChecked(grammar, value)` gives the whole-grammar guarantee: it prints,
  parses the output back, and fails unless the result equals the original. It
  catches a wrong branch and a grammar where no branch prints a value
  faithfully. Use it in tests, or as the default for a Schema `codec`.

For a `choice` of plain values (a number in decimal or hex, say), the default
`first` selection is fine and picks the first form as canonical. Reach for
`choiceOn` when the branches carry a discriminant, and for `is` on `transform`
(or `decodeTo` with a Schema) when they do not.

## Transformations and their guarantees

`transform` and `transformOrFail` claim no law: the two directions need not be
inverse, so a value may print as text that parses back to something else. When
you mean to claim the directions are inverse, say so:

- `iso` — plain functions you claim are inverse.
- `partialIso` — `Result`-returning functions that agree where both succeed.
- `decodeTo(schema)` — a transform guarded by an Effect Schema.

The claim is recorded, not proved. `auditFidelity(grammar)` lists every
transform that makes no such claim, so you can find the unchecked steps in a
grammar you expected to be invertible.

## Round-trip laws and testing

`effect-grammar/testing` exports helpers for the grammar laws. The library
removes unbound whitespace, so grammars do not round-trip text exactly; two laws
hold instead:

- `parse(print(value)) = value` — printing keeps a value's meaning.
- `print(parse(text)) = canonical(text)` — parsing then printing settles on one
  canonical form, and printing that form again does not change it.

```ts
import { assertPrintParse, checkPrintParse } from "effect-grammar/testing"
import * as FastCheck from "effect/testing/FastCheck"

assertPrintParse(grammar, value)
checkPrintParse(grammar, arbitrary) // property test over an Arbitrary<A>
```

`assertParsePrintCanonical` and `checkCanonicalization` cover the second law.

## Validating a grammar

A dependent grammar (`take`, `repeat`, `match`) can bind a ref in one `gen` and
use it in another, which only fails when it runs. `validate(grammar)` reports
those staged errors up front: a ref used outside its gen, or unbounded
repetition of a grammar that is known to match the empty string. Validation does
not run transforms, so it treats their empty-match behavior as unknown; the
parser still rejects a repeated item that consumes no input. (`choiceOn` and
`matchValue` reject duplicate keys when you build them.) `compile(grammar)`
validates once and returns prepared `parse`, `print`, `printChecked`, `render`,
and `fidelity`.

## Whitespace

`trivia` skips any whitespace and prints nothing. `spaces` requires some and
prints one space. `lexeme(g)` is `g` followed by `trivia`. Because `trivia`
prints nothing, two lexemes print with nothing between them: `(+ 1 2)` comes
back as `(+12)`, which reads as the one symbol `+12`. Put `spaces` where the
printed text needs a gap, and `trivia` only where it does not:

```ts
const list = G.wrap(
  G.seq(G.literal("("), G.trivia),
  G.sepBy(expr, G.spaces),
  G.seq(G.trivia, G.literal(")")),
)
```

If you need the original whitespace back, bind it instead of skipping it: a
`regex(/\s*/, "ws")` that you return from the generator round-trips like any
other field.

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
- [Binary message](./examples/binary.ts): bit fields, varints, UTF-8, a derived
  length, a `Uint8Array` Schema codec, and the round-trip laws
- [Scheme](./examples/scheme.ts): recursive expressions, tokens, and canonical
  whitespace
- [GitHub search](./examples/github-search.ts): a larger search-query DSL
- [IP address](./examples/ip.ts): transforms and Schema refinements
- [Printing showcase](./examples/printing.ts): parsing, printing, rendering, and
  print failures
