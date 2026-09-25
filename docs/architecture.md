# Developer architecture

The library interprets one grammar graph for parsing, printing, diagnostics, and
notation. This document maps internal ownership and invariants for contributors.
Public usage and compatibility changes belong in the
[migration guide](migration.md).

## Ownership

| Module                                     | Responsibility                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/core.ts`                              | Grammar and domain types, node union, scope identity, grammar construction, cached suspension resolution  |
| `src/ref.ts`                               | Opaque ref identity, private expression metadata, construction scope checks, `get`                        |
| `src/env.ts`                               | Execution frames, unbound slots, expression evaluation, case lookup                                       |
| `src/pattern.ts`                           | Return-pattern conversion and validation, slot-to-path bindings, parse materialization, print unification |
| `src/combinators.ts`                       | Primitive graph construction and structural lowering of products and syntax wrappers                      |
| `src/derived.ts`                           | Helpers composed from primitives, including `taggedChoice`                                                |
| `src/parse.ts`                             | Input cursor, backtracking, parse failures, progress and recursion guards                                 |
| `src/print.ts`                             | Local print constraints, branch policy, recursion guard, final round-trip check                           |
| `src/analysis.ts`                          | Scope-aware structural graph walk and structured diagnostic issues                                        |
| `src/internal/syntax.ts`                   | Shared structural proof that an omitted step is syntax-only                                               |
| `src/internal/describe.ts`                 | Shallow grammar names for errors and diagnostics                                                          |
| `src/errors.ts`, `src/internal/runtime.ts` | Error data and formatting, exception-to-Result boundaries, print paths                                    |
| `src/internal/bytes.ts`, `src/binary.ts`   | Private byte-string conversion, byte terminals, public byte runners and codec                             |
| `src/internal/prefixed.ts`                 | Shared text/byte length-prefix composition                                                                |
| `src/internal/schema.ts`, `src/schema.ts`  | Shared Schema adapter and its text specialization                                                         |
| `src/testing.ts`                           | Shared law implementation specialized for text and bytes                                                  |
| `src/index.ts`, `src/text.ts`              | Public root exports and the Text facade                                                                   |

## Construction, execution, and per-value checks

Construction builds the graph. A `gen` callback runs once, with refs instead of
parsed values. Constructors reject malformed counts, cases, scope usage, and
return patterns. These errors throw. Construction does not prove that a grammar
parses or prints every value.

Execution interprets the graph. Parsing fills a frame in step order, then
materializes the return pattern. Printing unifies the supplied value with the
return pattern, then prints each step from its bound slot. Unreturned slots
receive `undefined`. Each sequence stops at the first failure.

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
- Choice policy `"roundTrip"` reparses each printable candidate through that
  choice, with the current environment. It can select a later branch.
- `print` reparses the final output through the whole grammar and uses
  `Equal.equals`. `printUnchecked` omits only this final check.
- Law helpers use unchecked printing to report value-preservation and
  canonicalization failures with test-specific context.

## Expressions and return patterns

An _expression_ reads a dependent input. `Expr` contains a whole-slot `Ref`, a
property projection `Prop`, or a numeric `Const`. `get` constructs projections.
`env.ts` evaluates them against the current frame and its ancestors. An absent
binding is `Unbound`, distinct from a slot bound to `undefined`.

A _return pattern_ describes the output shape and its inverse binding. Its tree
contains whole refs, constants, objects, and arrays. It cannot contain property
projections. Every returned ref belongs to the owning generator and appears
once. `pattern.ts` computes one slot-to-path map at construction. Diagnostics
and print errors consume that map instead of rebuilding ownership.

This separation keeps dependency lookup independent from value reshaping.
Transforms reshape ordinary values after a generator returns its whole refs.
`between`, `prefix`, and `suffix` use ordinary `Gen` nodes with a whole-ref
result. Their syntax steps explicitly print `undefined` through `Skip` nodes. No
interpreter needs a separate `Wrap` case.

## Domains and module dependencies

`Grammar<A, D>` keeps `A` invariant and `D` covariant. Child domains combine by
union, and neutral `never` contributes no domain. String syntax contributes
`"text"`, even when empty. Domain restrictions apply at public runner, codec,
and law-helper types. Runtime nodes do not carry a domain brand.

Both interpreters use strings internally. Binary runners convert `Uint8Array` to
raw byte strings and select byte diagnostics. These strings and the
domain-polymorphic runner functions are private package details.

Dependencies point from public facades and adapters toward interpreters and
graph primitives. Derived helpers build primitives. Interpreters share frames,
patterns, errors, and runtime utilities. Printing depends on parsing for
round-trip checks. Parsing does not depend on printing. Structural analysis does
not depend on either interpreter or execute their callbacks.

`core.ts` has a type-only dependency on `ReturnPattern`. `pattern.ts` uses core
types and runtime primitives, so this link does not create a runtime cycle. The
Schema adapter depends on supplied runners and notation. Core combinators do not
import the adapter. Internal modules import concrete modules, not public export
barrels. `text.ts` is the intentional facade that re-exports `index.ts`.

`package.json` defines the supported import boundary. Internal modules ship for
relative runtime imports and declarations, but have no public package subpaths.
`test/package.test.ts` checks the packed exports and consumer declarations.
`test/domain-types.ts` checks source and packed domain boundaries.
