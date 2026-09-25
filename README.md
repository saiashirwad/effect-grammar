# effect-grammar

Define a parser, printer, and Effect schema codec from one grammar.

## Documentation

- [Quick start](#quick-start)
- [Migration guide for the breaking simplification](docs/migration.md)
- [Developer architecture and invariants](docs/architecture.md)
- [Examples](#examples)

## Install

Requires Node.js 20 or later and Effect v4.

```sh
npm install effect@rc effect-grammar
```

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

`G.literal` matches fixed text. `G.gen` defines the fields to parse and print.
Import `codec` and its `CodecOptions` type from `effect-grammar/Schema`. For an
explicit text entry point, import `effect-grammar/Text`. It provides the root
helpers and text runners, plus `codec` and `CodecOptions`.

Encoding checks that the output parses back to an equal value using
`Equal.equals`. It does not preserve the original text's spelling.

## Parsing and printing without Schema

Use the grammar directly with `parse`, `print`, or `printUnchecked`. Each
returns an Effect `Result`:

```ts
import { Result } from "effect"

const parsed = G.parse(endpoint, "https://effect.website:443")

if (Result.isSuccess(parsed)) {
  console.log(parsed.success)
  // { host: "effect.website", port: 443 }
}

const invalid = G.parse(endpoint, "https://effect.website:nope")

if (Result.isFailure(invalid)) {
  console.error(invalid.failure)
  // ParseError
}

const printed = G.print(endpoint, {
  host: "effect.website",
  port: 443,
})
// Result containing "https://effect.website:443"
```

`parse` requires the whole input to match. `print` checks that the output parses
back to an equal value using `Equal.equals`. `printUnchecked` skips this
whole-output check. Both printers still enforce the grammar's local constraints.

Use `transform` for value-returning decode/encode callbacks and
`transformOrFail` for callbacks returning `Result` with a string error. Neither
claims an inverse law; `print` checks the round trip for each value.

During parsing and printing, exceptions from callbacks, lazy thunks, property
getters, proxy traps, and equality hooks become `ParseError` or `PrintError`
failures. This policy also applies through transforms, labels, suspensions, and
syntax wrappers. Print failures retain the field or index path where available.
Sequences stop at the first failure. Parsing uses the normal backtracking rules
for choices, optional values, and repetitions. Printing follows the selected
choice policy. Error names are shallow and do not resolve unrelated lazy thunks.
Grammar constructors can still throw for malformed definitions.

Binary diagnostics use byte offsets and byte counts. A binary `RoundTrip` issue
stores its `printed` output as a `Uint8Array` and formats it as hexadecimal
bytes.

To validate a transformed value with a Schema guard, use
`inner.pipe(G.transform({ decode, encode }), G.filter(Schema.is(schema),
name))`. The guard checks the value in both directions. It does not run Schema
transformations.

`choice([first, second])` takes a nonempty readonly tuple of branches. By
default, it prints with the first branch that accepts the value. Use
`choice([first, second], { print: "roundTrip" })` to try later branches when a
candidate's output reads back differently through the choice. `ChoiceOptions`
defines the optional `print` policy, either `"first"` or `"roundTrip"`. This
branch search also applies with `printUnchecked`. `print` checks the final
output of the whole grammar. Both policies parse branches in the same order.

Printing a `gen` object requires exactly its declared fields. Parsing repeated
items requires input progress. Empty matches fail rather than loop.

## Refs and dependent fields

Inside `gen`, `yield*` binds an opaque `Ref<A>`. Use `get(ref, key)` to select a
field for `take`, `repeat`, or `match`:

```ts
const message = G.gen(function*() {
  const header = yield* G.struct({ size: G.integer.pipe(G.suffix(":")) })
  const body = yield* G.take(G.get(header, "size"))
  return { header, body }
})
// "3:abc" parses to { header: { size: 3 }, body: "abc" }
```

Nested fields use nested calls, such as `G.get(G.get(ref, "header"), "size")`.
Direct property access such as `ref.size` is a type error. Ref coercion and
enumeration, including object spread, throw during grammar construction.

Return each bound value as a whole ref, either directly or inside an object or
tuple. Property refs from `get` cannot appear in return patterns. To flatten or
rename fields, apply `transform` to the grammar. Its callbacks receive ordinary
values and must describe both the decode and encode directions.

`match(selector, entries)` chooses a branch from a ref and checks that the cases
cover the selector's type. Its result type is the union of the branch results.
TypeScript does not correlate that result with the selector in a returned
object. For example, `{ kind, value }` has independent union fields, not a
discriminated union. Use `taggedChoice` or `dispatch` for a discriminated
result. Printing still checks the selected branch at runtime.

Text `take` and `lengthPrefixed` count UTF-16 code units, as JavaScript string
`.length` does. For example, `"😀"` has length 2. Binary byte counts use bytes.
`repeat` and `countPrefixed` count items in either domain.

## Structural diagnostics

`G.diagnose(grammar)` returns structural issues. Each issue has a stable `_tag`,
a grammar-graph `path`, and a human-readable `message`:

```ts
const incomplete = G.gen(function*() {
  yield* G.regex(/[a-z]+/, "word")
})

G.diagnose(incomplete)
// [{ _tag: "OmittedValue", path: ["steps", 0], message: "gen: step 1 ..." }]
```

The issue tags are `OmittedValue`, `OutOfScopeRef`, `EmptyRepetition`, and
`InvalidSuspend`. Paths start at the root and use zero-based indices. Edges
include `steps`, `options`, `cases` (followed by an index and `grammar`),
`inner`, `sep`, and `resolved` for a suspension's target. Ref issues end at
`count`, `min`, `max`, or `scrutinee`. Empty-repetition issues point to the
repeated `inner` grammar. Shared suspensions are checked once per ancestor scope
path, with issues at the first graph path visited in that scope.

An omitted `gen` step must be structurally syntax-only:

- `literal` and `skip` can be omitted.
- Labels preserve this property. `between`, `prefix`, and `suffix` use `gen`
  sequences that explicitly supply `undefined` to their opening and closing
  syntax. A wrapper is syntax-only when its inner grammar is syntax-only.
- `optional`, `choice`, and `match` require every child or branch to have it.
- A nested `gen` must contain only syntax-only steps and return constant
  `undefined` or a whole ref to one of its steps. An empty object or tuple is a
  value.
- A suspension must resolve to syntax-only structure without a cycle.

Return other outputs or discard them explicitly with `skip(printAs)`.
Transforms, including filters, are opaque even when their callbacks could
produce or accept `undefined`. Dependent syntax such as
`G.take(length).pipe(G.skip("abc"))` can be omitted inside the owning `gen`.
Diagnostics check ref scope but do not evaluate the dependent count or the
discarded value.

Diagnostics never run encode, decode, or predicate callbacks. They can resolve
suspension thunks to inspect the graph, and thunk failures become issues.
Recursive graphs terminate. Empty-match checks report proven empty matches and
leave unknown cases, including dependent `match` branches and opaque transforms,
to runtime progress checks. An empty issue list does not guarantee successful
parsing or printing for every value.

`G.describe(grammar)` returns a shallow name without resolving suspensions.

## Binary

Use `effect-grammar/Binary` to parse and print bytes with the same grammar
helpers. This header contains an 8-bit version and a big-endian 16-bit length:

```ts
import { Result } from "effect"
import * as G from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

const header = G.struct({
  version: Binary.uint8,
  length: Binary.uint16,
})

Result.getOrThrow(Binary.parse(header, Uint8Array.of(0x01, 0x00, 0x03)))
// { version: 1, length: 3 }

Result.getOrThrow(Binary.print(header, { version: 1, length: 3 }))
// Uint8Array [1, 0, 3]
```

`Binary.bytes(count)` reads and writes a `Uint8Array`. The count can be a number
or a length ref. `Binary.lengthPrefixed(length)` derives the prefix from the
byte length. Use `Binary.ascii` or `Binary.utf8` to convert a byte grammar to
string values. These helpers retain byte input and output.
`Binary.codec(grammar, target, options)` creates a Schema codec with
`Uint8Array` input and output. `Binary.hex(bytes)` formats bytes for display.

## Grammar domains

`Grammar<A, D = "text">` tracks the value type `A` and the input/output domain
`D`. Text runners and `Schema.codec` require `"text"`. Binary runners and
`Binary.codec` require `"bytes"`. `Binary.Grammar<A>` is shorthand for
`Grammar<A, "bytes">`, including recursive annotations.

Shared combinators preserve domains through products, branches, repetitions,
transforms, and every `gen` yield. A mixed composition has domain `"text" |
"bytes"`. You can construct and inspect it, but neither domain's runners or
codecs accept it. A string delimiter or separator imposes the text domain, even
when the string is empty. Use `Binary.literal(...)` for byte syntax.

`NeutralGrammar<A>` means `Grammar<A, never>`. Neutral grammars consume and emit
no domain-specific input, so they compose with either domain. `empty`,
`tuple()`, `struct({})`, `seq()`, and a `gen` with no yields are neutral.
Applying `as`, `transform`, or another shared wrapper preserves that neutrality.
Use `empty` for an absent delimiter, rather than `literal("")`.

```ts
const framed = Binary.uint8.pipe(G.between(Binary.literal(0xaa), G.empty))
Binary.parse(framed, Uint8Array.of(0xaa, 1))

const mixed = G.tuple(G.integer, Binary.uint8)
// G.parse(mixed, "1") and Binary.parse(mixed, bytes) are type errors.
```

Domain separation is a TypeScript boundary. Both domains use the same internal
string interpreter. Raw byte strings and domain-polymorphic runners are private
to the package.

## Grammar law helpers

`effect-grammar/testing` provides `assertPrintParse`,
`assertParsePrintCanonical`, `checkPrintParse`, and `checkCanonicalization` for
text grammars. `Testing.Binary` provides the same functions for byte grammars.
Canonicalization checks that printing preserves the parsed value and that a
second canonicalization produces the same output. Byte output comparisons use
byte contents, and byte input diagnostics use hex.

```ts
import * as Testing from "effect-grammar/testing"

Testing.Binary.assertPrintParse(Binary.varuint, 1)
Testing.Binary.assertParsePrintCanonical(Binary.varuint, Uint8Array.of(0x81, 0))
// Uint8Array [1]
```

## Examples

- [Endpoint grammar](examples/endpoint.ts)
- [Length-prefixed text](examples/netstring.ts)
- [Schema errors](examples/schema-error.ts)
- [Printing behavior](examples/printing.ts)
- [Recursive Scheme syntax](examples/scheme.ts)
- [Binary DNS messages](examples/dns.ts)

See [`examples/`](examples/) for JSON, IP addresses, HTTP ranges, and more.
