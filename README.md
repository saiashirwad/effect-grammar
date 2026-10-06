# effect-grammar

Write a grammar once and get a parser, a printer, and an Effect Schema codec
from it.

```sh
npm install effect@rc effect-grammar
```

Requires `effect` 4 (currently release candidate) and Node 20 or later.

## The problem

When a format has a separate parser and printer, the two drift apart. You fix a
case in the parser but forget the printer, and now printed values can't be read
back. `effect-grammar` describes the format once. Parsing and printing are two
interpretations of the same description. Printing checks its own output by
parsing it again.

## Quick start

Parse and print endpoints in the form `https://host:port`:

```ts
import { Schema } from "effect"
import * as G from "effect-grammar"
import * as GrammarSchema from "effect-grammar/Schema"

const endpoint = G.gen(function*() {
  yield* G.literal("https://")
  const host = yield* G.regex(/[^:/?#]+/, "host")
  yield* G.literal(":")
  const port = yield* G.integer
  return { host, port }
})

const Endpoint = GrammarSchema.codec(
  endpoint,
  Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int,
  }),
)

Schema.decodeSync(Endpoint)("https://effect.website:443")
// { host: "effect.website", port: 443 }

Schema.encodeSync(Endpoint)({ host: "effect.website", port: 443 })
// "https://effect.website:443"
```

You can also run the grammar directly. `G.parse` and `G.print` return a `Result`
instead of throwing:

```ts
G.parse(endpoint, "https://effect.website")
// Failure: line 1, column 23: expected ":", found end of input

G.print(endpoint, { host: "a:b", port: 1 })
// Failure: .host: expected /[^:/?#]+/, got "a:b"
```

## How `gen` works

The `gen` body runs once when the grammar is built, not once per input. Each
`yield*` records a step. Steps that produce a value (like `G.integer`) return a
`Ref`, a placeholder for the value that will exist at parse or print time.
Syntax-only steps (like `G.literal`) expose `void`.

The object you return describes the shape of the result. Parsing fills it in
from the input. Printing works backwards: it matches the value against the shape
to find what each step should print.

A `Ref` is not a runtime value. Reading its fields or coercing it throws. `if
(ref)` tests the placeholder's truthiness, not the parsed value. Use `G.match`
to branch and `G.get` to read a field.

## Values that depend on earlier values

Many formats specify a length before the data. A later step can depend on an
earlier one by passing its `Ref`:

```ts
const netstring = G.gen(function*() {
  const length = yield* G.integer
  yield* G.literal(":")
  const payload = yield* G.take(length)
  yield* G.literal(",")
  return { length, payload }
})

G.parse(netstring, "5:hello,")
// Success: { length: 5, payload: "hello" }

G.print(netstring, { length: 3, payload: "hello" })
// Failure: .payload: expected 3 characters, got "hello"
```

When printing, the dependency is checked, not computed. If you want the printer
to compute the length for you, use `G.lengthPrefixed` or `G.countPrefixed`.

Use `G.get(ref, "field")` to depend on a field of an earlier value. Use
`G.match(ref, cases)` to choose a grammar based on a `Ref`. `take`, `repeat`,
and `match` accept refs.

## Binary formats

`effect-grammar/Binary` works on `Uint8Array`. It provides fixed-width integers
(`uint8` to `uint64`, `int8` to `int64`, big- and little-endian), `float32`,
`float64`, LEB128 `varuint`, zigzag `varint`, bit fields with `bits`, raw
`bytes`, and `ascii` and `utf8` decoding. 64-bit integers are bigints.

Structural combinators from `effect-grammar` work on both text and bytes:

```ts
import * as G from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

// A count byte, then that many length-prefixed UTF-8 strings.
const strings = Binary.lengthPrefixed(Binary.uint8).pipe(
  Binary.utf8,
  G.countPrefixed(Binary.uint8),
)

Binary.print(strings, ["€", "yo"])
// Success: <02 03 e2 82 ac 02 79 6f>
```

Types keep text and bytes apart. A grammar mixing both cannot be passed to
`G.parse` or `Binary.parse`.

The first byte counts strings. Each following prefix counts encoded bytes, so
`"€"` has length 3. `Binary.bytes(size)` checks a supplied size;
`Binary.lengthPrefixed` derives it when printing.

| Operation                                              | Text                       | Bytes                           |
| ------------------------------------------------------ | -------------------------- | ------------------------------- |
| Products, generators, choices, repetitions, transforms | Shared `G` combinators     | Shared `G` combinators          |
| Fixed syntax                                           | `G.literal("x")`           | `Binary.literal(0x78)`          |
| Fixed-length payload                                   | `G.take(size)`             | `Binary.bytes(size)`            |
| Length-prefixed payload                                | `G.lengthPrefixed(length)` | `Binary.lengthPrefixed(length)` |
| Runners                                                | `G.parse`, `G.print`       | `Binary.parse`, `Binary.print`  |

String delimiters are text syntax. Use a byte grammar for a binary delimiter,
such as `G.suffix(Binary.literal(0))`. `G.empty` is neutral in either domain.

## Printing is checked

`G.print` prints the value, parses the output, and fails unless it reads back as
an equal value (compared with `Equal.equals`). This confirms that values survive
the round trip. It does not try to reproduce the original spelling: `007` parses
to `7` and prints as `7`.

`G.printUnchecked` skips the final reparse. It still checks local constraints
such as regex patterns, counts, and filters.

When a `G.choice` has several branches that could print a value, the default
policy (`"roundTrip"`) picks a branch whose output parses back to the original
value. If the branches cannot overlap, `{ print: "first" }` takes the first
branch that prints, which is cheaper.

## Grammar law helpers

`effect-grammar/testing` provides assertions for the two round-trip laws, along
with property-based versions built on FastCheck:

```ts
import * as Testing from "effect-grammar/testing"
import * as FastCheck from "effect/testing/FastCheck"

// print, then parse, gives back the same value
Testing.checkPrintParse(
  netstring,
  FastCheck.string().map((payload) => ({ length: payload.length, payload })),
)

// parse, then print, gives canonical output that parses to the same value
Testing.assertParsePrintCanonical(G.integer, "007")
// "7"
```

`checkCanonicalization` and `assertPrintParse` cover the other combinations.
`Testing.Binary` provides the same helpers for byte grammars.

## Diagnostics

`G.diagnose` inspects structure without running transform or predicate
callbacks. It can resolve lazy suspension thunks. It returns a list of issues:

```ts
G.diagnose(G.regex(/a*/, "as").pipe(G.many()))
// [{ _tag: "EmptyRepetition", path: ["inner"], message: "unbounded repetition of as, which can match the empty string, ..." }]
```

It reports values that are produced but never returned, refs used outside their
`gen`, repetitions whose items can match empty input, and suspensions that fail
to resolve. An empty list does not prove that every input parses or every value
prints.

## Exports

| Import                   | Contents                                                    |
| ------------------------ | ----------------------------------------------------------- |
| `effect-grammar`         | Combinators, text terminals, `parse`, `print`, `diagnose`   |
| `effect-grammar/Text`    | Everything in the root export, plus the text Schema `codec` |
| `effect-grammar/Binary`  | Byte terminals, `parse`, `print`, `codec`, and schemas      |
| `effect-grammar/Schema`  | The text Schema `codec`                                     |
| `effect-grammar/testing` | Round-trip law helpers for text and bytes                   |

## Further reading

- [Architecture](docs/architecture.md) for contributors
- [Contributing](docs/contributing.md) for checks, benchmarks, and test
  ownership
- [examples/](examples/) for complete grammars: JSON, DNS queries, HTTP byte
  ranges, connection strings, and more

## Background

The library sits between two common styles of parser combinators. Applicative
parsers can be inspected and run backwards, but later steps cannot depend on
earlier values. Monadic parsers allow that dependency through opaque functions,
but cannot be printed.

`effect-grammar` allows a later step to depend on an earlier value, but only
through expressions the library can inspect (`Ref`, `G.get`, constants). This
restriction lets one grammar both parse and print a format with length prefixes
and type tags.

Related work:

- Rendel and Ostermann, _Invertible Syntax Descriptions: Unifying Parsing and
  Pretty Printing_ (Haskell Symposium 2010)
- Jim, Mandelbaum and Walker, _Semantics and Algorithms for Data-dependent
  Grammars_ (POPL 2010)
- Mokhov, Lukyanov, Marlow and Dimino, _Selective Applicative Functors_
  (ICFP 2019)

## License

MIT
