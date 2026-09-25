# Migration guide

This guide covers the breaking simplification after 0.5.0. It maps the previous
API to the domain-aware grammar model and explains changes to refs and checks.

## API replacements

The examples use `G` for `effect-grammar` and `Binary` for
`effect-grammar/Binary`.

| Before                                                  | After                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Grammar<A>` for either domain                          | `Grammar<A>` for text, `Grammar<A, "bytes">` or `Binary.Grammar<A>` for bytes                      |
| `Silent`                                                | `void` as the grammar's value type                                                                 |
| `many(inner)`, `between(inner, "(", ")")`               | `inner.pipe(G.many())`, `inner.pipe(G.between("(", ")"))`                                          |
| `choice(a, b)`                                          | `G.choice([a, b], { print: "first" })`                                                             |
| `checkedChoice(a, b)`                                   | `G.choice([a, b])`                                                                                 |
| `choiceOn(tag, cases)`, `choiceOnEntries(tag, entries)` | `G.dispatch(tag, [[key, grammar], ...])`                                                           |
| `matchValue(ref, entries)`                              | `G.match(ref, entries)`                                                                            |
| `taggedChoice(tag, cases)` with object cases            | `G.taggedChoice(tag, [[key, grammar], ...])`                                                       |
| `iso(...)`, `partialIso(...)`                           | `G.transform(...)`, `G.transformOrFail(...)`                                                       |
| Transform options `is` and `name`                       | Separate `G.filter(predicate, name)` and `G.label(name)`                                           |
| Grammar `decodeTo`                                      | A transform plus `G.filter(Schema.is(schema), name)`, or a Schema codec for Schema transformations |
| `printChecked(grammar, value)`                          | `G.print(grammar, value)`                                                                          |
| Previous unchecked `print(grammar, value)`              | `G.printUnchecked(grammar, value)`                                                                 |
| Root `codec` and `CodecOptions`                         | Import from `effect-grammar/Schema`, or use `effect-grammar/Text`                                  |
| `validate(grammar)`                                     | `G.diagnose(grammar)` with structured issues                                                       |
| `prepare`, `Prepared`, `GrammarValidationError`         | `G.diagnose` and direct parse/print calls                                                          |
| Deep `describe(grammar)`, `render(grammar)`             | Removed. `G.describe` returns a shallow name                                                       |
| Byte-unit `take`, raw byte-string readers               | `Binary.bytes(count)`, which produces `Uint8Array`                                                 |
| `Binary.Bit`, `Uint(n)`, `Int(n)`                       | `Binary.bitSchema`, `uintSchema(n)`, `intSchema(n)`                                                |
| `Binary.Uint8` through `Uint32`, `Int8` through `Int32` | `Binary.uintSchema(bits)`, `intSchema(bits)`                                                       |
| `Binary.Uint64`, `Int64`                                | `Binary.uint64Schema`, `int64Schema`                                                               |

`Fidelity` and `auditFidelity` have no replacement. Transforms do not claim an
inverse law. `transformOrFail` callbacks return `Result` with string failures.
Unary helpers still support `G.optional(inner)` and `inner.pipe(G.optional)`.
`G.regex(expression, name)` remains a labeling shorthand.

## Refs and value reshaping

A yielded value is an opaque `Ref<A>` during construction. Syntax grammars
expose `void` at the type level. A ref has no parsed value until execution.

Previous property access and ref spread:

```ts
const packet = G.gen(function*() {
  const header = yield* G.struct({ size: G.integer.pipe(G.suffix(":")) })
  const body = yield* G.take(header.size)
  return { ...header, body }
})
```

The replacement selects dependent fields with `get`, returns whole refs, and
reshapes ordinary values in a transform:

```ts
import * as G from "effect-grammar"

const packet = G.gen(function*() {
  const header = yield* G.struct({ size: G.integer.pipe(G.suffix(":")) })
  const body = yield* G.take(G.get(header, "size"))
  return { header, body }
}).pipe(
  G.transform({
    decode: ({ header, body }) => ({ size: header.size, body }),
    encode: ({ size, body }: { size: number; body: string }) => ({
      header: { size },
      body,
    }),
  }),
)

G.parse(packet, "3:abc") // Success: { size: 3, body: "abc" }
G.print(packet, { size: 3, body: "abc" }) // Success: "3:abc"
```

Nested fields use `G.get(G.get(ref, "header"), "size")`. Array indices use
`G.get(ref, 0)`. Property refs work as dependent inputs to `take`, `repeat`, and
`match`, but cannot appear in return patterns.

Each returned ref must belong to that generator and appear only once. Return
patterns support constants, plain objects, and dense tuples. They reject cycles,
symbol fields, and unsupported object shapes. Ref enumeration and coercion throw
during construction, including object spread and interpolation.

Omitted yields print with `undefined`. Diagnostics require these steps to be
structurally syntax-only, and `gen` throws at construction when one provably
produces a value. An omitted suspension that is not yet resolved is left to
diagnostics. Return value-producing steps or use `skip(printAs)` to supply their
print value. A transform is opaque to this structural check, even when its
callbacks accept or produce `undefined`.

`match` requires cases that cover the selector type. Its result is a union of
branch values, without TypeScript correlation to a separately returned selector.
`dispatch` uses tagged object branches. `taggedChoice` adds a tag and a `value`
payload to each branch, which produces a discriminated union.

## Domains and recursive annotations

`Grammar<A, D = "text">` tracks the value type and input/output domain. Shared
combinators preserve domains through every child, including omitted `gen`
yields. A mixed grammar has domain `"text" | "bytes"`. Construction and
inspection accept it, but text and byte runners, codecs, and law helpers reject
it at typecheck time.

`NeutralGrammar<A>` is `Grammar<A, never>`. `empty`, `tuple()`, `struct({})`,
`seq()`, and yield-free generators are neutral. Shared wrappers preserve
neutrality. An empty text literal or string delimiter still imposes `"text"`.

```ts
import * as G from "effect-grammar"
import * as Binary from "effect-grammar/Binary"

const framed = Binary.uint8.pipe(G.between(Binary.literal(0xaa), G.empty))
Binary.parse(framed, Uint8Array.of(0xaa, 1)) // Success: 1

const mixed = G.tuple(G.integer, Binary.uint8)
// Neither G.parse(mixed, text) nor Binary.parse(mixed, bytes) typechecks.
G.diagnose(mixed) // Structural inspection is allowed.

type Tree = { readonly value: number; readonly children: ReadonlyArray<Tree> }
const tree: Binary.Grammar<Tree> = G.suspend(() =>
  G.struct({
    value: Binary.uint8,
    children: tree.pipe(G.countPrefixed(Binary.uint8)),
  })
)
Binary.parse(tree, Uint8Array.of(7, 0)) // Success: { value: 7, children: [] }
```

Text recursion uses `G.Grammar<Tree>`. Byte recursion needs
`Binary.Grammar<Tree>` or `G.Grammar<Tree, "bytes">`. A domain-generic helper
must preserve its `D` parameter instead of returning the default text type.

`Binary.ascii` and `Binary.utf8` change the value type to `string`, while their
input/output domain remains `"bytes"`. Text lengths count UTF-16 code units.
Binary lengths count bytes. Repetition counts items in either domain.

## Printing and execution failures

`print` first prints the value, then parses the complete output and compares the
result with `Equal.equals`. This check preserves values, not the original input
spelling. Text and Binary codec encoding use checked printing.

`printUnchecked` skips the final whole-output check. It still checks local
constraints such as patterns, counts, filters, and transform failures. Object
patterns require exactly their declared own fields, including fields whose value
is `undefined`.

The default choice policy, `"roundTrip"`, searches for output that reads back
equally through the choice itself. This search also runs under `printUnchecked`.
It reparses each candidate, so nested recursive choices cost more. `{ print:
"first" }` selects the first branch that prints, for branches that cannot
overlap. The final checked print can then fail without searching other branches.
Both policies parse branches in declaration order.

Runners return `Result` failures for exceptions from callbacks, lazy thunks,
getters, proxy traps, and equality hooks. Sequences stop at the first failure.
Choices, optional values, and repetitions retain their normal parse
backtracking. Print failures retain field or index paths where available.
Construction errors for malformed grammar definitions still throw.

`Binary.parse` uses the shared `ParseError`. Its `pos` is a byte offset, and its
`line` and `column` are `undefined`. Binary `RoundTrip` issues store `printed`
as `Uint8Array` and format it as hex.

## Structural diagnostics and law checks

`diagnose` returns issues with `_tag`, `path`, and `message`. The tags are
`OmittedValue`, `OutOfScopeRef`, `EmptyRepetition`, and `InvalidSuspend`. Paths
describe grammar-graph edges, not value fields. They use zero-based indices.
Syntax wrappers now use `steps` paths because they lower to generators.
`optional` and `dispatch` lower to choices, so their paths use `options`.

Diagnostics never call encode, decode, or predicate callbacks. They can resolve
suspension thunks to inspect structure, and thunk failures become issues.
Recursive inspection terminates. Empty-match analysis reports proven cases and
leaves unknown cases to runtime progress checks. An empty issue list does not
prove that every input parses or every value prints.

`describe` returns a shallow name without resolving suspensions. `render` is
removed, and Schema codecs no longer set a `description` annotation from it.

`effect-grammar/testing` provides text law helpers, with byte equivalents under
`Testing.Binary`. Canonicalization checks preserve the parsed value and require
idempotent output. See the
[README law helper example](../README.md#grammar-law-helpers) and
[developer architecture](architecture.md) for the check boundaries.
