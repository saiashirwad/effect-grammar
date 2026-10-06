# effect-grammar

Describe a text or binary format once, then parse and print it with the same
grammar.

```sh
npm install effect@rc effect-grammar
```

Requires `effect` version `>=4.0.0-rc.112 <5` and Node 20 or later.

## Why this exists

`effect-grammar` derives parsing and printing from the same grammar. You do not
have to keep two descriptions of a format in sync.

User transformations and ambiguous alternatives can still break round trips. By
default, printing verifies its output by parsing it back. It fails if the result
is not an equal value.

Use the grammar directly, or pair it with an Effect `Schema` to validate values.

## Quick start

Parse and print an endpoint like `https://host:port`. Define the grammar, then
derive an Effect `Schema` codec from it.

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

const Endpoint = GrammarSchema.codec(endpoint)
// Schema.Codec<{ host: string; port: number }, string>

Schema.decodeSync(Endpoint)("https://effect.website:443")
// { host: "effect.website", port: 443 }

Schema.encodeSync(Endpoint)({ host: "effect.website", port: 443 })
// "https://effect.website:443"

Schema.encodeSync(Endpoint)({ host: "effect.website", port: 4.5 })
// throws: Expected an integer at ["port"]
```

The grammar specifies the syntax. The codec derives the value schema from it.

Schema synchronous APIs throw on invalid input. See
[Schema codecs](#schema-codecs) for details on derived checks and custom target
schemas.

You can run the grammar directly without a Schema. `G.parse` and `G.print`
return synchronous Effect `Result`s with a success or failure. Parsing requires
the whole input to match:

```ts
G.parse(endpoint, "https://effect.website")
// Failure: line 1, column 23: expected ":", found end of input

G.print(endpoint, { host: "a:b", port: 1 })
// Failure: .host: expected /[^:/?#]+/, got "a:b"
```

Constructing an invalid grammar definition can throw.

## How `gen` works

The `G.gen` block runs **once** when the grammar is constructed, not on every
parse.

Each `yield*` records a step in order. Steps that produce data, like
`G.integer`, yield a `Ref`, a placeholder for a future value. Syntax-only steps,
like `G.literal`, have a yield type of `void`. This is a TypeScript type, not a
guarantee that the yielded value is `undefined` during construction.

The object you return dictates the final value shape.

- **Parsing** executes the steps, collects yielded values, and fills your return
  layout.
- **Printing** matches your value against the layout to find data for each
  placeholder, then emits the steps.

A `Ref` is only a placeholder. You cannot inspect its fields or perform math on
it during `gen`. Testing `if (ref)` checks placeholder truthiness, not the
parsed value.

To map values, use `G.transform` with decode and encode callbacks on the
completed grammar. `G.filter` checks a predicate in both directions.

You must include every value-producing yield in the return layout, or explicitly
discard it by choosing a print representation with `G.skip(printAs)`.
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
encoded bytes. Use `Binary` for byte-oriented formats.

Printing verifies the dependency but does not compute it. To have the printer
compute the length automatically, wrap the payload in `G.lengthPrefixed`:

```ts
const payload = G.lengthPrefixed(G.integer.pipe(G.suffix(":"))).pipe(
  G.suffix(","),
)

G.print(payload, "hello")
// Success: "5:hello,"
```

Other ways to use dependent values:

- `G.get(ref, "field")` reads a field from an object `Ref`.
- `G.match(ref, entries)` chooses grammar branches based on a `Ref`.
- `G.countPrefixed` derives array item counts.
- `G.repeat(count)(item)` accepts a number or a `Ref<number>`.

## Binary formats

`effect-grammar/Binary` provides operations for `Uint8Array`:

- Signed and unsigned integers at 8, 16, 32, and 64 bits.
- LEB128 `varuint` and zigzag `varint`.
- `float32`, `float64`, `bits`, and `bytes`.
- `ascii` and `utf8`, which wrap byte payload grammars for strings.

Fixed-width integers default to big-endian. Use a `le` suffix for little-endian
variants like `uint16le`. Fixed-width 64-bit integers yield `bigint` values.
`varuint` and `varint` yield numbers. `varuint` supports integers from `0`
through `Number.MAX_SAFE_INTEGER`. `varint` supports integers from `-(2 ** 52)`
through `2 ** 52 - 1`.

Shared combinators from the `effect-grammar` root work on both text and bytes.

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
UTF-8 bytes, so `"€"` takes 3 bytes.

`Binary.bytes(size)` checks a supplied size. `Binary.lengthPrefixed` computes
the encoded byte length when printing.

Types keep text and byte grammars separate in runners and codecs.
`G.literal(":")` introduces text syntax. Use `G.suffix(Binary.literal(0))` for
explicit byte delimiters. `G.empty` is neutral and works in both domains.

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
grammar. Printing fails if the parsed value does not equal the original (using
`Equal.equals`).

This verifies the value survives the round trip, not that its spelling is
preserved. For example, `G.integer` parses `"007"` to `7`, which prints as
`"7"`.

Sharing a grammar does not guarantee every value can print. For instance,
`G.transform` has separate `decode` and `encode` callbacks, but their types do
not prove `decode(encode(value))` equals `value`.

Checked printing catches violations for the supplied value. Use the
[law helpers](#testing-and-diagnostics) to test transformations across many
values.

### Skipping the final check

Because it parses the output again, checked printing costs an extra pass.
`G.printUnchecked` skips this final whole-grammar verification but still
enforces local constraints like regular expressions, lengths, and filters.

### Choice printing policies

`G.choice` has two print policies:

- **`"roundTrip"` (default):** reparses each printable candidate through the
  choice and accepts one that returns an equal value. `G.printUnchecked` retains
  this branch check.
- **`"first"`:** takes the first branch that prints, without checking it through
  the choice. Use `{ print: "first" }` when branches cannot overlap.

`G.print` performs the final whole-grammar verification with either policy.

## Schema codecs

- `GrammarSchema.codec(grammar)` returns a `Schema.Codec<A, string>`.
- `Binary.codec(grammar)` returns a `Schema.Codec<A, Uint8Array>`.

Both codecs derive a value schema from the grammar:

- **Decoding** parses the input, then validates the result.
- **Encoding** validates the value, then prints it with checked printing.

Use `Schema.toType(codec)` to get only the value schema.

### What derives automatically

- **Structure:** products, `gen` layouts, constants, choices, `dispatch`,
  optional fields, and recursion.
- **Constraints:** repetition bounds, labels, filters, full-match `regex`, and
  lengths for `take` and `Binary.bytes`.
- **Built-in values:** `integer`, binary integer ranges, floats, `bits`,
  `ascii`, and `utf8`.

Fields returned from `G.optional` are **required keys** whose value may be
`undefined`.

Derivation does not rerun already constructed `gen` blocks or run decode,
encode, or predicate callbacks. It resolves suspension thunks, which may
construct and run new `gen` blocks.

### Custom transformations

`G.transform` and `G.transformOrFail` cannot be read backwards. A custom
transform must declare the schema of its decoded values with `to` when deriving
a codec:

```ts
const percent = G.regex(/\d+%/, "percent").pipe(
  G.transform({
    to: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    decode: (text) => Number(text.slice(0, -1)),
    encode: (value) => `${value}%`,
  }),
)
```

`codec` throws if a transform lacks `to`, naming the transform and its path.

`to` describes the transform's output type; only its type side is used. The
codec validates decoded values and encode inputs against it.

`G.parse` and `G.print` ignore `to`. It does not steer choice backtracking.

### Dependent values and printability

Values that depend on earlier ones become checks with Schema paths. A
`take(length)`, `repeat(count)`, or `match(kind, ...)` inside a `gen` is checked
against the bound value it reads. Failures include a path, such as `Expected 3
characters` at `["payload"]`.

Dependencies on references from an enclosing `gen` are **not part of the
schema** when those references cross into:

- A `choice`, `dispatch`, or `match` branch.
- An `optional` or repeated item.
- A transform or suspension.

An inner `gen` still derives checks for its own locally bound dependencies. For
example, wrapping the netstring grammar above in `G.optional` preserves its
length check.

The derived schema checks structure, **not printability**. Checked printing
still enforces excluded dependencies and rejects `encode` output that no longer
fits the grammar. Failures are reported as Schema issues at the value's path.

By default, derived structural schemas preserve excess object keys, which
printing rejects just as `G.print` does. Custom schemas can handle excess keys
differently.

### Explicit target schemas

Pass an explicit target schema to validate into a different type, add brands, or
use Schema transformations and services. The grammar's values must match the
target's encoded side:

```ts
const StrictEndpoint = GrammarSchema.codec(
  endpoint,
  Schema.Struct({ host: Schema.NonEmptyString, port: Schema.Int }),
)
```

With an explicit target, the grammar's transforms do not need `to`.

### Recursive codec performance limits

Automatic codecs support recursive grammars, including parentheses that do not
change the returned value and nested objects or arrays.

**Both codec construction and value validation can become expensive** when many
mutually recursive alternatives are separated by filters or labels. The derived
schema can expand into many paths.

To manage the cost:

- **Reuse codecs.** Construct them once to avoid repeated derivation.
- **Supply a target schema.** `GrammarSchema.codec(grammar, target)` and
  `Binary.codec(grammar, target)` bypass automatic derivation. The target must
  supply the value constraints you need.

An explicit target does not remove parser or printer recursion costs. It also
does not guarantee cheap target-schema validation.

Normalization assumes deterministic, non-mutating predicates. Deeply nested
values still face Effect's normal recursive-validation depth limits.

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

- `assertPrintParse` checks a single value.
- `checkCanonicalization` tests accepted inputs for value preservation and
  idempotent canonical output.
- `Testing.Binary` provides the same helpers for byte grammars.

These helpers use `printUnchecked` so failures provide targeted messages instead
of failing at the printer's final check.

### Diagnostics

If your grammar behaves unexpectedly, `G.diagnose(grammar)` inspects its
structure and reports:

- Unreturned values.
- Invalid reference scopes.
- Unbounded repetitions whose items can match empty input.

```ts
G.diagnose(G.regex(/a*/, "as").pipe(G.many()))
// Returns issues including _tag: "EmptyRepetition" on path ["inner"]
```

Diagnostics do not execute predicate or transform callbacks. Lazy suspension
thunks may run, and broken suspensions are reported.

An empty issues list does not prove all inputs parse or all values print.

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
- [Contributing](docs/contributing.md) – Checks, benchmarks, and test ownership.

## Background

`effect-grammar` sits between two traditional parser combinator styles.

- **Applicative parsers** can be inspected and run backwards but struggle with
  formats where later steps depend on earlier values.
- **Monadic parsers** allow arbitrary dependencies using opaque functions but
  hide the structure needed for printing.

By providing a constrained dependency system (`Ref`, `G.get`, `G.match`), this
library keeps the grammar inspectable enough to reverse while remaining
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
