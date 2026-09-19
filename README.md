# effect-grammar

Write a grammar once, then use it to parse text, print values, or derive an
Effect Schema codec. Grammars are bidirectional by design, with explicit
round-trip checking when you need an invertibility guarantee.

## Install

`effect` is a peer dependency:

```sh
npm install effect effect-grammar
```

## Quick start

```ts
import { Schema } from "effect"
import * as G from "effect-grammar"

const endpoint = G.gen(function* () {
  yield* G.literal("https://")
  const host = yield* G.regex(/[^:/?#]+/, "host")
  yield* G.literal(":")
  const port = yield* G.integer
  return { host, port }
})

const Endpoint = G.codec(
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

## Operations

- `parse(grammar, text)` interprets from cursor zero and succeeds only after
  consuming the whole string.
- `print(grammar, value)` runs the grammar's printer. It validates local printer
  requirements but does not verify that the result parses back to the same
  value.
- `printChecked(grammar, value)` prints, reparses the whole output, and compares
  the result with Effect's equality. It fails when that value round trip does
  not hold.
- `prepare(grammar)` runs the library's static validation once, then returns
  `parse`, `print`, and `printChecked` functions bound to the grammar, plus its
  rendering and fidelity audit. It is not compilation or optimization; runtime
  failures remain possible.
- `codec(grammar, schema)` creates an Effect Schema codec. Encoding uses checked
  printing by default; `{ roundTrip: "off" }` selects unchecked printing.

`regex(re, name)` stores the source and flags without `g` or `y`. During parsing
it uses a fresh sticky matcher at the current cursor, so `^`, `$`, lookarounds,
and flags retain JavaScript `RegExp` semantics relative to the original full
input. Printing requires the value itself to be a string matched in full. The
caller's `RegExp` and `lastIndex` are not mutated.

## Composition and correctness

`choice` parses branches in order and prints with the first printer that accepts
the value. `checkedChoice` uses the first accepting branch whose produced text
reparses to an equal value. `choiceOn(tag, cases)` instead dispatches printing
from an existing discriminant field; parsing is still ordered and can remain
ambiguous. `taggedChoice(tag, cases)` wraps each branch's value as
`{ [tag]: key, value }` and dispatches by that generated tag.
`literals(...strings)` is a choice of strings whose value is the string that
matched. It tries longer strings first, so `literals(">", ">=")` still reads
`>=`.

For explicit branch order or number/boolean discriminants, use
`choiceOnEntries(tag, entries)` with an array of `[key, grammar]` entries.
`choiceOn` and `taggedChoice` reject JavaScript array-index keys because object
enumeration can reorder them.

`gen` result objects are exact printer patterns: printing rejects missing,
extra, symbol, or otherwise unexpected own keys. Arrays must have exactly the
expected length.

`many`, `sepBy`, and exact `repeat` require every successfully parsed item to
advance the cursor; zero-width items fail rather than loop. `validate`/`prepare`
report repetitions whose item can be proved to match empty input, but validation
is intentionally not a proof of all behavior.

`take(count)` reads a fixed number of UTF-16 code units and
`repeat(item, count)` a fixed number of items; the count is a number or a ref
bound earlier in the same `gen`. `lengthPrefixed(length)` and
`countPrefixed(item, count)` parse a prefix and then that many UTF-16 code units
or items, and derive the prefix from the value when printing, so the value does
not carry it. `filter(predicate, name)` keeps a grammar's value only when the
predicate accepts it, in both directions.

`merge(...parts)` sequences grammars that produce objects and flattens their
fields into one object. Each part must have statically known fields: a `struct`,
a `gen` that returns an object, another `merge`, `Binary.bits`, or a `filter`
over any of these. A general transform is rejected, because its fields cannot be
known. Printing splits the value by those fields, so errors keep flat paths.
Duplicate fields are rejected on construction.

`suspend(() => grammar)` enables recursive definitions. Its thunk is evaluated
lazily on first resolution and the resolved grammar is cached. Direct left
recursion at the same parse position and recursive printing that does not
consume a value are rejected; recursive grammars must be productive.

Transforms state different fidelity intentions:

- `transform` and `transformOrFail` make no inverse claim.
- `iso` records the author's inverse claim; the library does not prove it.
- `partialIso` records a fallible pair intended to agree where both directions
  succeed.
- `auditFidelity` lists transforms without a full inverse claim; an empty list
  is not proof of a round trip.

Use `printChecked` or the helpers from `effect-grammar/testing` to test the
values and accepted texts relevant to your grammar. These are properties to
verify, not laws guaranteed for every grammar.

## Binary

`effect-grammar/Binary` applies the same grammars to a `Uint8Array`. Bytes pass
through the engine as a binary string with one code unit per byte, so every core
combinator composes with the byte-oriented ones.

```ts
import { Schema } from "effect"
import * as Grammar from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

const header = Grammar.merge(
  Grammar.struct({ id: Binary.uint16 }),
  Binary.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 }),
  Grammar.struct({ qdcount: Binary.uint16 }),
)

const Header = Binary.codec(
  header,
  Schema.Struct({
    id: Binary.Uint16,
    qr: Binary.Bit,
    opcode: Binary.Uint(4),
    aa: Binary.Bit,
    tc: Binary.Bit,
    rd: Binary.Bit,
    ra: Binary.Bit,
    z: Binary.Uint(3),
    rcode: Binary.Uint(4),
    qdcount: Binary.Uint16,
  }),
)

Schema.decodeSync(Header)(Uint8Array.of(0xbe, 0xef, 0x01, 0x00, 0x00, 0x01))
// { id: 48879, qr: 0, opcode: 0, aa: 0, tc: 0, rd: 1, ra: 0, z: 0, rcode: 0, qdcount: 1 }
```

- `uint8` to `uint64`, `int8` to `int64`, `float32`, and `float64` are
  big-endian; the `le` suffix, as in `uint16le`, reads little-endian. 64-bit
  integers are bigints. `float32` prints only numbers that single precision
  holds exactly.
- `varuint` is unsigned LEB128 within the safe integer range, and `varint` its
  zigzag-encoded signed form for integers from `-(2 ** 52)` to `2 ** 52 - 1`.
  Parsing accepts padded encodings of any length; printing writes the shortest
  one.
- `bits(layout)` splits a whole number of bytes into named fields, first field
  highest. A one-bit field has type `0 | 1`; wider fields are numbers of up to
  53 bits. Printing rejects a field that does not fit its width.
- `bytes(count)` reads a `Uint8Array` of a constant or previously bound length,
  `lengthPrefixed(length)` derives its prefix, a byte count, when printing, and
  `literal(...bytes)` matches a fixed sequence such as a magic number.
- `ascii` and `utf8` turn a `Uint8Array` grammar into a string grammar. Invalid
  bytes fail to parse and unencodable strings fail to print; `auditFidelity`
  lists `utf8` as partial.
- `Bit`, `Uint(bits)` and `Int(bits)` for 1 to 53 bits, `Uint8` to `Uint64`, and
  `Int8` to `Int64` are schemas for the values these grammars produce, and
  `hex(bytes)` formats a `Uint8Array` for display.
- `parse`, `print`, `printChecked`, and `codec` mirror the text operations over
  `Uint8Array`. Parse failures report a byte offset and the byte found; input
  that ends inside a fixed-width field fails at the end of the input.

A grammar that prints a character above `0xff` cannot be encoded and fails to
print.

## Examples

The `examples/` directory includes endpoint and connection-string grammars,
JSON, HTTP ranges, IP addresses, recursive Scheme syntax, contextual printing,
Schema error integration, and a binary DNS message codec.
