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

For explicit branch order or number/boolean discriminants, pass `choiceOn` an
array of `[key, grammar]` entries. Object-form `choiceOn` and `taggedChoice`
reject JavaScript array-index keys because object enumeration can reorder them.

`gen` result objects are exact printer patterns: printing rejects missing,
extra, symbol, or otherwise unexpected own keys. Arrays must have exactly the
expected length.

`many`, `sepBy`, and exact `repeat` require every successfully parsed item to
advance the cursor; zero-width items fail rather than loop. `validate`/`prepare`
report repetitions whose item can be proved to match empty input, but validation
is intentionally not a proof of all behavior.

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

## Examples

The `examples/` directory includes endpoint and connection-string grammars,
JSON, HTTP ranges, IP addresses, recursive Scheme syntax, contextual printing,
and Schema error integration.
