# effect-grammar

Describe a text or binary format once, then parse and print it with the same
grammar.

```sh
npm install effect@rc effect-grammar
```

Requires `effect` 4 (currently release candidate) and Node 20 or later.

## Why this exists

`effect-grammar` derives parsing and printing from the same grammar. Format
structure is shared, not maintained in two implementations that can drift apart.
User-supplied transformations and ambiguous alternatives can still break round
trips, so printing verifies its output by default: it succeeds only if that
output parses back to an equal value.

You can use the grammar directly, or pair it with an Effect `Schema` to validate
the values and integrate with the rest of your application.

## Quick start

Parse and print a simple endpoint in the form `https://host:port`. Define the
grammar, then pair it with an explicit target `Schema` to validate the values.

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

The grammar specifies the syntax of the format. The target `Schema` provides
value validation and optional transformations. The `codec` adapter requires
both. Schema synchronous APIs throw on invalid input.

You can also run the grammar directly without a Schema. `G.parse` and `G.print`
return synchronous Effect `Result`s containing a success or failure. Parsing
requires the whole input to match:

```ts
G.parse(endpoint, "https://effect.website")
// Failure: line 1, column 23: expected ":", found end of input

G.print(endpoint, { host: "a:b", port: 1 })
// Failure: .host: expected /[^:/?#]+/, got "a:b"
```

Constructing an invalid grammar definition can throw.

## How `gen` works

The `G.gen` block runs **once** when the grammar is constructed, not every time
an input is parsed.

Each `yield*` records a format step in order. Steps that produce data, like
`G.integer`, yield a `Ref`—a placeholder for a future value. Syntax-only steps,
like `G.literal`, yield `void`.

The object you return dictates the final shape of the value.

- When **parsing**, the library executes the steps, collects the yielded values,
  and fills in your return layout.
- When **printing**, the library takes your supplied value, matches it against
  the layout to find the data for each placeholder, and emits the steps.

Because a `Ref` is just a placeholder, you cannot inspect its fields or perform
math on it during `gen`. Testing `if (ref)` checks placeholder truthiness, not
the parsed value. To map values, `G.transform` requires both decode and encode
callbacks on the completed grammar. `G.filter` checks a predicate in both
directions.

Every value-producing yield must be included in the return layout, or explicitly
discarded by choosing a printing representation with `G.skip(printAs)`.
Syntax-only yields do not need to be returned.

## Values that depend on earlier values

Some formats define lengths or types dynamically. A later step can depend on an
earlier one by passing its `Ref`.

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

This text variant of a netstring counts JavaScript UTF-16 code units, not
encoded bytes. Use `Binary` for byte-oriented formats. The dependency is
verified during printing, not automatically computed. If you want the printer to
compute the length for you, use `G.lengthPrefixed` to wrap the payload:

```ts
const payload = G.lengthPrefixed(G.integer.pipe(G.suffix(":"))).pipe(
  G.suffix(","),
)

G.print(payload, "hello")
// Success: "5:hello,"
```

To depend on a field from an object `Ref`, use `G.get(ref, "field")`. To choose
between grammar branches based on a `Ref`, use `G.match(ref, entries)`.
`G.countPrefixed` derives the item count for arrays, and `G.repeat(count)(item)`
accepts a number or a `Ref<number>`.

## Binary formats

`effect-grammar/Binary` provides operations for `Uint8Array`. It includes signed
and unsigned integers at 8, 16, 32, and 64 bits, defaulting to big-endian with a
`le` suffix for little-endian variants, such as `uint16le`. 64-bit values, as
well as LEB128 `varuint` and zigzag `varint`, yield bigints. It also provides
`float32`, `float64`, `bits`, and `bytes`. To expose strings, `ascii` and `utf8`
wrap byte payload grammars.

Shared combinators from the root `effect-grammar` export work on both text and
bytes.

```ts
import * as G from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

const strings = Binary.lengthPrefixed(Binary.uint8).pipe(
  Binary.utf8,
  G.countPrefixed(Binary.uint8),
)

Binary.print(strings, ["€", "yo"])
// Success: bytes 02 03 e2 82 ac 02 79 6f
```

The first byte counts the array items. The following prefixes count encoded
UTF-8 bytes, so `"€"` takes 3 bytes. `Binary.bytes(size)` checks a supplied
size, whereas `Binary.lengthPrefixed` computes the encoded byte length when
printing.

Types keep text and byte grammars separate at the runners and codecs. A string
literal like `G.literal(":")` introduces text syntax. For explicit byte
delimiters, use `G.suffix(Binary.literal(0))`. `G.empty` is neutral and works in
both domains.

## Useful combinators

| Operation      | Text                                       | Bytes                                                   |
| -------------- | ------------------------------------------ | ------------------------------------------------------- |
| Structure      | `G.struct`, `G.tuple`, `G.gen`             | Shared `G` combinators                                  |
| Alternation    | `G.choice`, `G.taggedChoice`, `G.optional` | Shared `G` combinators                                  |
| Repetition     | `G.many`, `G.sepBy`, `G.repeat`            | Shared `G` combinators                                  |
| Fixed syntax   | `G.literal("x")`                           | `Binary.literal(0x78)`                                  |
| Payload size   | `G.take(size)`                             | `Binary.bytes(size)`                                    |
| Payload prefix | `G.lengthPrefixed(length)`                 | `Binary.lengthPrefixed(length)`                         |
| Count prefix   | `G.countPrefixed(count)`                   | Shared `G.countPrefixed`                                |
| Runners        | `G.parse`, `G.print`, `G.printUnchecked`   | `Binary.parse`, `Binary.print`, `Binary.printUnchecked` |

## Checked printing

`G.print` formats the value, then parses the entire output back through the
grammar. If the parsed value is not equal to the original (using
`Equal.equals`), printing fails. This verifies that particular value survives
the round trip. It does not try to preserve original spelling: `G.integer`
parses `"007"` to `7`, which prints as `"7"`.

Sharing a grammar does not prove that every value can be printed. For example,
`G.transform` accepts separate `decode` and `encode` callbacks; their types do
not establish that `decode(encode(value))` equals `value`. Checked printing
detects a violation for the supplied value and returns a failure instead of
output that changes it. Use the law helpers below to test transformations across
a range of values.

Because checked printing parses the output again, it costs an extra pass.
`G.printUnchecked` skips the final whole-grammar verification, but still
enforces local constraints like regular expressions, lengths, and filters.

When a `G.choice` has several branches, the default `"roundTrip"` print policy
reparses each printable candidate through the choice and accepts one that reads
back as an equal value. `G.printUnchecked` retains this branch check. If
branches cannot overlap, `{ print: "first" }` takes the first branch that prints
without checking it through the choice. `G.print` still performs the final
whole-grammar verification with either policy.

## Testing and diagnostics

`effect-grammar/testing` provides FastCheck properties and assertions to test
your grammar:

```ts
import * as Testing from "effect-grammar/testing"
import * as FastCheck from "effect/testing/FastCheck"

// Tests that printing and then parsing yields the same value
Testing.checkPrintParse(
  netstring,
  FastCheck.string().map((payload) => ({ length: payload.length, payload })),
)

// Tests that parsing and then printing yields canonical text
Testing.assertParsePrintCanonical(G.integer, "007")
// "7"
```

`assertPrintParse` checks a single value, and `checkCanonicalization` tests
accepted inputs for value preservation and idempotent canonical output.
`Testing.Binary` provides the same helpers for byte grammars. These helpers use
`printUnchecked` so failures provide targeted messages rather than relying on
the printer's final check.

If your grammar behaves unexpectedly, `G.diagnose(grammar)` inspects its
structure and returns a list of issues, including unreturned values, invalid
reference scopes, and unbounded repetitions whose items can match empty input:

```ts
G.diagnose(G.regex(/a*/, "as").pipe(G.many()))
// Returns issues including _tag: "EmptyRepetition" on path ["inner"]
```

Diagnostics do not execute predicate or transform callbacks, but lazy suspension
thunks may run, and broken suspensions are reported. An empty issues list does
not prove all inputs parse or all values print.

## Exports

- `effect-grammar` – Shared structural combinators, text terminals, `parse`,
  `print`, `printUnchecked`, `diagnose`.
- `effect-grammar/Binary` – Byte terminals, binary runners, integer and bit
  schemas, text encodings, and binary Schema `codec`.
- `effect-grammar/Schema` – The text `codec` adapter for Effect Schema.
- `effect-grammar/Text` – Re-exports everything in the root plus the text Schema
  `codec`.
- `effect-grammar/testing` – Round-trip law assertions and properties for text
  and bytes.

## Further reading

- [examples/](examples/) – Working grammars for JSON, DNS queries, HTTP byte
  ranges, connection strings, and more.
- [Architecture](docs/architecture.md) – Implementation details for
  contributors.
- [Contributing](docs/contributing.md) – Checks, benchmarks, and test ownership.

## Background

`effect-grammar` sits between two traditional styles of parser combinators.
Applicative parsers can be inspected and run backwards, but cannot easily handle
formats where later steps depend on earlier values. Monadic parsers allow
arbitrary dependencies using opaque functions, but hide the structure needed for
printing.

By providing a constrained dependency system (`Ref`, `G.get`, `G.match`), this
library keeps the grammar inspectable enough to reverse, while remaining
expressive enough to handle length prefixes and tags.

Related work:

- Rendel and Ostermann, _Invertible Syntax Descriptions: Unifying Parsing and
  Pretty Printing_ (Haskell Symposium 2010)
- Jim, Mandelbaum and Walker, _Semantics and Algorithms for Data-dependent
  Grammars_ (POPL 2010)
- Mokhov, Lukyanov, Marlow and Dimino, _Selective Applicative Functors_
  (ICFP 2019)

## License

MIT
