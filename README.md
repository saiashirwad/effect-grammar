# effect-grammar

Define a parser, printer, and Effect schema codec from one grammar.

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

`G.literal` matches fixed text. `G.gen` defines the fields to parse and print.

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
claims an inverse law; `print` checks the round trip for each value. Callback
exceptions become parse or print failures with grammar context.

`choice([first, second])` takes a nonempty readonly tuple of branches. By
default, it prints with the first branch that accepts the value. Use
`choice([first, second], { print: "roundTrip" })` to try later branches when a
candidate's output reads back differently through the choice. `ChoiceOptions`
defines the optional `print` policy, either `"first"` or `"roundTrip"`. This
branch search also applies with `printUnchecked`. `print` checks the final
output of the whole grammar. Both policies parse branches in the same order.

Printing a `gen` object requires exactly its declared fields. Repeated items
must consume input. Empty matches fail rather than loop.

## Refs and dependent fields

Inside `gen`, `yield*` binds an opaque `Ref<A>`. Use `get(ref, key)` to select a
field for `take`, `repeat`, or `match`:

```ts
const message = G.gen(function* () {
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

## Structural diagnostics

`G.diagnose(grammar)` returns structural issues. Each issue has a stable `_tag`,
a grammar-graph `path`, and a human-readable `message`:

```ts
const incomplete = G.gen(function* () {
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
`G.render(grammar)` returns full grammar notation and can resolve suspensions.

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

## Examples

- [Endpoint grammar](examples/endpoint.ts)
- [Length-prefixed text](examples/netstring.ts)
- [Schema errors](examples/schema-error.ts)
- [Printing behavior](examples/printing.ts)
- [Recursive Scheme syntax](examples/scheme.ts)
- [Binary DNS messages](examples/dns.ts)

See [`examples/`](examples/) for JSON, IP addresses, HTTP ranges, and more.
