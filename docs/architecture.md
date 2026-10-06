# Developer architecture

The library interprets one grammar graph for parsing, printing, diagnostics, and
notation. This document maps internal ownership and invariants for contributors.
Public usage belongs in the [README](../README.md).

## Ownership

| Module                                     | Responsibility                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core.ts`                              | Grammar and domain types, node union, case lookup, cached suspension resolution                                                      |
| `src/internal/generator.ts`                | Symbolic refs, construction scopes, sequence compilation, return layouts, frames, dependency evaluation, output assembly and binding |
| `src/combinators.ts`                       | Public constructors, product lowering, explicit optional, dispatch, and delimiter nodes                                              |
| `src/derived.ts`                           | Helpers composed from constructors, including `taggedChoice`                                                                         |
| `src/parse.ts`                             | Input cursor, backtracking, diagnostic evidence, progress and recursion guards                                                       |
| `src/print.ts`                             | Local print constraints, branch policy, recursion guard, final round-trip check                                                      |
| `src/analysis.ts`                          | Scope-aware structural graph walk and diagnostic issues                                                                              |
| `src/internal/syntax.ts`                   | Structural proof that an omitted step is syntax-only                                                                                 |
| `src/internal/describe.ts`                 | Shallow grammar names for errors and diagnostics                                                                                     |
| `src/errors.ts`, `src/internal/runtime.ts` | Error data, formatting, exception boundaries, and print paths                                                                        |
| `src/internal/bytes.ts`, `src/binary.ts`   | Byte-string conversion, byte terminals, byte runners, and codec                                                                      |
| `src/internal/prefixed.ts`                 | Shared text and byte length-prefix composition                                                                                       |
| `src/internal/schema.ts`, `src/schema.ts`  | Shared Schema adapter and its text specialization                                                                                    |
| `src/testing.ts`                           | Law implementations specialized for text and bytes                                                                                   |
| `src/index.ts`, `src/text.ts`              | Public root exports and the Text facade                                                                                              |

`gen` is a construction API, not a runtime node. It compiles to `Sequence`.
Products use the same reversible sequence representation. Optional values,
tagged dispatch, and delimiters have direct nodes because lowering them would
hide their execution rules.

## One generator in both directions

Consider the netstring grammar from the README. Its four yields compile to four
steps:

| Slot | Grammar        | Returned path |
| ---- | -------------- | ------------- |
| 0    | `integer`      | `["length"]`  |
| 1    | `literal(":")` | Omitted       |
| 2    | `take(length)` | `["payload"]` |
| 3    | `literal(",")` | Omitted       |

The `take` node holds a dependency expression for slot 0. The return layout is
an object with `length` reading slot 0 and `payload` reading slot 2. Expressions
read earlier values; the layout describes the result. These are different jobs.

Parsing `5:hello,` fills the local frame in step order. `take` evaluates its
count from slot 0, then stores `"hello"` in slot 2. `assembleOutput` constructs
`{ length: 5, payload: "hello" }` from the layout and those local slots.

Printing first calls `bindOutput`. It checks the supplied object's fields and
fills slots 0 and 2 before any step prints. The interpreter then emits the
integer, colon, payload, and comma. Omitted slots remain `Unbound` and receive
`undefined` only when their steps print. `take` checks the bound payload against
the bound length. Checked printing finally parses the complete output again.

## Construction, execution, and per-value checks

Construction builds the graph. A `gen` callback runs once, with refs instead of
parsed values. Constructors reject malformed counts, cases, scope usage, and
return patterns. These errors throw. `gen` also throws when an unreturned step
provably produces a value. That check never resolves a suspension: one that is
unresolved at construction, or a cycle, is unknown and left to `diagnose` and
printing. Construction does not prove that a grammar parses or prints every
value.

Execution interprets the graph. Parsing assembles a result after its steps
succeed. Printing binds the whole return layout before executing steps. Binding
reads fields depth-first in return-layout order; execution follows yield order.
Both stop at the first failure. A failed binding can partially fill its fresh
frame, which the caller abandons.

Runtime boundaries convert callback and value-inspection exceptions into
`ParseError` or `PrintError` failures. They preserve normal backtracking and
choice policies. Error naming uses shallow `describe`, so reporting an error
does not resolve unrelated suspensions. Construction stays outside these
exception boundaries.

Checks have different scopes:

- `diagnose` inspects structure. It can resolve lazy thunks, but never probes
  encode, decode, or predicate callbacks. Unknown behavior remains unknown.
- Local execution checks apply to the actual input or value. Parsing rejects
  repetition elements that consume no input. Suspensions guard against active
  re-entry at the same parse position or with the same print value.
- Choice policy `"roundTrip"`, the default, reparses each printable candidate
  through that choice, with the current environment. It can select a later
  branch. Policy `"first"` skips this check for branches that cannot overlap.
- `print` reparses the final output through the whole grammar and uses
  `Equal.equals`. `printUnchecked` omits only this final check.
- Law helpers use unchecked printing to report value-preservation and
  canonicalization failures with test-specific context.

## Expressions and return layouts

An _expression_ reads a dependent input. `Expr` contains a whole-slot `Ref`, a
property projection `Prop`, or a numeric `Const`. `get` constructs projections.
`evaluate` reads them against the current frame and its ancestors. An absent
binding is `Unbound`, distinct from a slot bound to `undefined`.

A _return layout_ contains local slots, constants, objects, and arrays. Capture
checks that every returned ref belongs to the owning generator. Compilation
rejects repeated slots and stores each returned path on its sequence step. A
path of `[]` means the whole result; `undefined` means omitted. Diagnostics and
print errors read that step metadata. There is no persistent binding map.

Output assembly reads only the sequence's own slots. It does not search ancestor
frames. Dependency expressions still need ancestor lookup for nested generators.
Property projections cannot appear in a return layout.

This separation keeps dependency lookup independent from value reshaping.
Transforms reshape ordinary values after a generator returns its whole refs.
`between`, `prefix`, and `suffix` construct `Surrounded` nodes. These execute
opening syntax, the inner grammar, and closing syntax in order using the
incoming frame. They introduce no slots or scope. Delimiters print with
`undefined`.

`Optional` tries its inner grammar and rewinds the cursor on failure. It prints
`undefined` as empty output. `Dispatch` keeps keys paired with grammars: parsing
tries cases in order, while printing selects only the case matching the tag.
Neither operation relies on transform callback identity or choice metadata.

## State lifetimes

Parsing keeps the cursor separate from `Diagnostics`. Backtracking rewinds
`pos`, but retains the furthest failure, expected tokens, and
`consumingSuccesses`. This counter records successful consuming grammar calls,
not characters. Labels use it to distinguish a direct mismatch from deeper
failure after a successful child.

Suspension resolution caches success on the node. Diagnosis separately caches
both success and failure for one call. `expanding` tracks the current recursive
expansion; `expandedUnder` records completed visits for each ancestor-scope
path. The parse and print recursion guards last only for active invocations.

## Domains and module dependencies

`Grammar<A, D>` keeps `A` invariant and `D` covariant. Child domains combine by
union, and neutral `never` contributes no domain. String syntax contributes
`"text"`, even when empty. Domain restrictions apply at public runner, codec,
and law-helper types. Runtime nodes do not carry a domain brand.

Both interpreters use strings internally. `toByteString` maps each byte to one
code unit; `fromByteString` reverses that representation. These operations are
not text decoding. Binary runners select byte diagnostics. These strings and the
domain-polymorphic runner functions are private package details.

Dependencies point from public facades and adapters toward interpreters and
graph constructors. Derived helpers build constructors. Interpreters share
generator binding operations, errors, and runtime utilities. Printing depends on
parsing for round-trip checks. Parsing does not depend on printing. Structural
analysis does not depend on either interpreter or execute their callbacks.

`core.ts` has type-only dependencies on `ReturnLayout` and `SequenceStep`.
`generator.ts` uses core runtime constructors, so those type links do not create
a runtime cycle. The Schema adapter depends on supplied runners and notation.
Core combinators do not import the adapter. Internal modules import concrete
modules, not public export barrels. `text.ts` is the intentional facade that
re-exports `index.ts`.

`package.json` defines the supported import boundary. Internal modules ship for
relative runtime imports and declarations, but have no public package subpaths.
`test/package.test.ts` checks the packed exports and consumer declarations.
`test/domain-types.ts` checks source and packed domain boundaries.
