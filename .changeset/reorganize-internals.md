---
"effect-grammar": minor
---

Simplify the grammar model and public API. This release contains breaking
changes.

### Grammar types and refs

- `Grammar<A, D = "text">` tracks the value and input/output domain.
  `Binary.Grammar<A>` means `Grammar<A, "bytes">`. Shared combinators preserve
  all input domains, including every `gen` yield. Mixed text/byte grammars can
  be inspected but cannot be passed to either domain's runners or codecs.
- `NeutralGrammar<A>` means `Grammar<A, never>`. `empty`, empty products and
  sequences, and yield-free generators are neutral. String delimiters always
  impose the text domain, even `""`. Use `empty` for an absent delimiter.
- `Silent` is removed. Syntax grammars produce `void`. Every `gen` yield binds a
  slot, and omitted slots print with `undefined`. `diagnose` reports omitted
  outputs that are not structurally syntax-only. Use `skip(printAs)` to discard
  a value explicitly.
- Refs are opaque. Use `get(ref, key)` for dependent fields, including nested
  fields and array indices. Direct property access is no longer supported.
  Coercion and enumeration, including spread, throw during construction.
- Return patterns contain whole bound refs, constants, plain objects, and dense
  tuples. Property refs, duplicate refs, refs from another generator, cyclic
  patterns, and unsupported object shapes are rejected at construction. Return
  the whole ref and use `transform` to flatten or reshape its value. Printing an
  object pattern requires exactly its declared own fields.

### Combinators and entry points

- Configured wrappers use pipe-only forms such as `inner.pipe(many())`,
  `inner.pipe(between("(", ")"))`, and `inner.pipe(transform(...))`. Their
  data-first overloads are removed. Unary helpers such as `optional` remain
  usable as `inner.pipe(optional)` or `optional(inner)`.
- `choice` takes a nonempty readonly tuple and optional `ChoiceOptions`:
  `choice([a, b], { print: "roundTrip" })`. The default `"first"` policy accepts
  the first printable candidate. The `"roundTrip"` policy replaces
  `checkedChoice` and searches for output that parses back equally through the
  choice. Both policies parse branches in order.
- `choiceOn` and `choiceOnEntries` become `dispatch`. `matchValue` becomes
  `match`. These helpers and `taggedChoice` take `[key, grammar]` entries.
  Integer-like keys are allowed. `taggedChoice` is derived from `dispatch` and
  `transformOrFail`, so empty or duplicate cases report `dispatch` errors.
- Use `transform` for value-returning callbacks and `transformOrFail` for
  callbacks returning `Result` with string failures. `iso`, `partialIso`,
  `Fidelity`, and `auditFidelity` are removed. Transforms no longer take `is` or
  `name`. Use `filter(predicate, name)` and `label(name)`.
- Grammar `decodeTo` is removed. Use `transform(...)` followed by
  `filter(Schema.is(schema), name)` for a Schema guard. This guard does not run
  Schema transformations. Use a codec for Schema decoding and encoding.
- Import `codec` and `CodecOptions` from `effect-grammar/Schema`, not the root.
  `effect-grammar/Text` re-exports the root API plus the Schema adapter.
  `Binary.codec` shares the adapter and retains byte input and output.
- `regex(re, name)` remains shorthand for `regex(re).pipe(label(name))`. `take`
  has no byte unit. Use `Binary.bytes(count)` for `Uint8Array` values. Raw
  byte-string readers and domain-polymorphic runners are private.
- Binary Schema exports use `bitSchema`, `uintSchema(n)`, `intSchema(n)`,
  `uint64Schema`, and `int64Schema` instead of the capitalized names.
- `effect-grammar/testing` adds `Binary` law helpers. Both domains share law
  checks for value preservation and idempotent canonicalization. Byte output
  comparisons use contents, and byte input diagnostics use hex.

### Execution and diagnostics

- `print` checks the whole output with `parse` and `Equal.equals`. The old
  unchecked behavior is `printUnchecked`. `printChecked` is removed. This
  applies to text, Binary, and codec encoding. Unchecked printing retains local
  constraints and the selected choice policy, including `"roundTrip"` search.
- Parse and print boundaries convert exceptions from callbacks, lazy thunks,
  property getters, proxy traps, and equality hooks to `Result` failures.
  Sequences stop at the first failure. Parsing retains normal backtracking, and
  printing retains its choice policy. Print failures retain field or index paths
  where available. Malformed grammar construction can still throw.
- Both domains use `ParseError`. Binary errors have a byte offset in `pos` and
  undefined `line` and `column`. Byte counts use byte terminology. Binary
  `RoundTrip` issues store `printed` as `Uint8Array` and display it as hex.
- `diagnose` replaces `validate` without an alias. `prepare`, `Prepared`, and
  `GrammarValidationError` are removed. Issues have `_tag`, grammar-graph
  `path`, and `message`. Tags are `OmittedValue`, `OutOfScopeRef`,
  `EmptyRepetition`, and `InvalidSuspend`.
- Diagnostics inspect structure without encode, decode, or predicate probes.
  They can resolve suspension thunks, report thunk failures, and terminate on
  recursive graphs. Empty-match analysis reports proven cases and leaves unknown
  cases to runtime progress checks. An empty issue list is not a proof that
  every input or value succeeds.
- `describe` gives a shallow name without resolving suspensions. `render` is
  removed. Schema codecs no longer set a `description` annotation.
- Return-pattern ownership is centralized. `between`, `prefix`, and `suffix`
  lower to `Gen` sequences with a whole-ref result. The `Wrap` node is removed.
  Their diagnostic paths use `steps`. Supplied syntax retains its original print
  failure instead of an omitted-value error.
- `optional` and `dispatch` lower to `Choice` nodes. The `Optional` and
  `Dispatch` nodes are removed. Diagnostic paths under `optional` use the
  lowered choice, such as `["inner", "options", 0, "inner", ...]` instead of
  `["inner", ...]`. Dispatch paths use `["options", i, ...]` instead of
  `["cases", i, "grammar", ...]`. Printing a defined value that `optional`'s
  inner grammar rejects reports "no choice branch accepts", listing both
  branches. Dispatch print errors are unchanged.
- The printer rejects a suspended grammar re-entered with the same value at any
  active depth. A nonproductive recursive choice branch can fall through instead
  of overflowing the stack.

See the repository's
[migration guide](https://github.com/saiashirwad/effect-grammar/blob/main/docs/migration.md)
for before/after examples and the
[architecture guide](https://github.com/saiashirwad/effect-grammar/blob/main/docs/architecture.md)
for module ownership and invariants.
