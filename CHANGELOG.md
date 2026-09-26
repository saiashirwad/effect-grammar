# effect-grammar

## 0.6.0

### Minor Changes

- [#26](https://github.com/saiashirwad/effect-grammar/pull/26) [`2060a7b`](https://github.com/saiashirwad/effect-grammar/commit/2060a7b84f2d202c390c2e161d0d9e0c8bdaa203) Thanks [@saiashirwad](https://github.com/saiashirwad)! - Simplify the grammar model and public API. This release contains breaking
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
    slot, and omitted slots print with `undefined`. `gen` throws when an omitted
    step provably produces a value; `diagnose` reports the rest that are not
    structurally syntax-only, such as unresolved suspensions. Use `skip(printAs)`
    to discard a value explicitly.
  - Refs are opaque. Use `get(ref, key)` for dependent fields, including nested
    fields and array indices. Direct property access, coercion, and enumeration,
    including spread, throw during construction.
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
    `choice([a, b], { print: "first" })`. The default `"roundTrip"` policy
    replaces `checkedChoice` and searches for output that parses back equally
    through the choice, at the cost of reparsing each candidate. `"first"` is an
    explicit opt-out for choices whose branches cannot overlap; it accepts the
    first printable candidate. Both policies parse branches in order.
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

## 0.5.0

### Minor Changes

- [#24](https://github.com/saiashirwad/effect-grammar/pull/24)
  [`51d23bb`](https://github.com/saiashirwad/effect-grammar/commit/51d23bb1d489e0fe8a3b6ef1898cea5d32a7feb2)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Add byte-oriented
  grammars and the combinators they needed.

  - Add the `effect-grammar/Binary` export: `uint8`, `uint16`, `uint32`,
    `uint16le`, `uint32le`, `bits`, `bytes`, `lengthPrefixed`, `literal`,
    `ascii`, and `utf8`, with `parse`, `print`, `printChecked`, and `codec` over
    `Uint8Array`, the `Bit` and `Uint` schemas, and `hex`. Parse failures report
    a byte offset.
  - `take` accepts a constant count as well as a ref.
  - Add `lengthPrefixed` and `countPrefixed`, which derive the prefix from the
    value when printing.
  - Add `filter`, which constrains a grammar's value with a predicate in both
    directions.
  - Add `merge`, which flattens object grammars into one object and keeps flat
    field paths in print errors. Its parts are structs, object-returning gens,
    other merges, `Binary.bits`, or a `filter` over one of those.

- [#25](https://github.com/saiashirwad/effect-grammar/pull/25)
  [`41fe8d1`](https://github.com/saiashirwad/effect-grammar/commit/41fe8d1f6aa2bafe4c6017a2540a3929c4e14053)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Round out the binary
  number grammars and add two small combinators.

  - `effect-grammar/Binary` adds `int8` to `int64`, `uint64`, `float32`,
    `float64`, their `le` variants, and the LEB128 `varuint` and zigzag
    `varint`, with the `Int`, `Int8`, `Int16`, `Int32`, `Uint64`, and `Int64`
    schemas. 64-bit integers are bigints.
  - `repeat` accepts a constant count as well as a ref. `validate` can prove
    that `repeat(item, 0)` matches empty input, and reports any other `repeat`
    whose item matches empty input, as it does for `many`.
  - Add `literals`, a choice of strings whose value is the matched string.
    Longer strings are tried first, so none is shadowed by its own prefix.
  - `validate` sees through transforms: one over a grammar that cannot match
    empty input cannot either, and `as`, `flag`, and `literals` match empty
    input when their literal does.
  - Print errors show a `Uint8Array` or `Buffer` as `<07 ab>` and a bigint as
    `5n`, at any depth in the value, instead of an indexed object or `[object
Object]`. A byte run of the wrong length reports its bytes rather than a
    binary string.

- [#11](https://github.com/saiashirwad/effect-grammar/pull/11)
  [`fae4dc2`](https://github.com/saiashirwad/effect-grammar/commit/fae4dc2bee3f5cfe046d715cf2bdc0aedfb452ec)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Make the round-trip
  law first-class, and ship the testing, validation, and packaging around it.

  This release intentionally removes the old `compile` function and `Compiled`
  type. Migrate `compile(grammar)` to `prepare(grammar)` and `Compiled<A>` to
  `Prepared<A>`. `prepare` validates once and returns a `Result` containing
  interpreters bound to the grammar; validation issues are returned as a
  `GrammarValidationError`. It does not compile or otherwise optimize them.

  The old `wrap` helper is also removed. Replace `wrap(open, inner, close)` with
  `between(open, inner, close)`. This rename is a breaking API change; `prefix`
  and `suffix` remain available for one-sided delimiters.

  - Add `printChecked`, which prints a value, parses the output back, and fails
    unless it reads as an equal value. This is the whole-grammar round-trip
    guarantee. `print` stays unchecked.
  - Replace `print(grammar, value, { verify: true })` with per-choice printer
    selection: `checkedChoice(...branches)` picks the first branch whose text
    parses back. The old `verify` option, which never checked dispatched
    (`choiceOn`) choices, is gone.
  - `codec` verifies the round trip on encode by default; pass `{ roundTrip:
"off" }` to skip it.
  - Add `choiceOnEntries`, which is `choiceOn` over an array of `[key, grammar]`
    entries, for an explicit parse order and number or boolean discriminants.
    `choiceOn` now rejects JavaScript array-index keys, whose enumeration order
    would otherwise change branch priority.
  - Distinguish transformations by the law they claim: `iso` (claimed inverse),
    `partialIso` (fallible, agrees where both succeed), and `decodeTo` (Schema
    guarded) alongside the law-free `transform` and `transformOrFail`.
    `auditFidelity` lists the transforms that claim no inverse.
  - Add `validate` and `prepare` to report staged errors — refs used outside
    their gen, and any nonzero repetition whose item is proven to match empty
    input — before parse or print. These checks are conservative, not proof of
    all runtime behavior. `choiceOn` and `matchValue` reject duplicate keys on
    construction.
  - Add the `effect-grammar/testing` export with `assertPrintParse`,
    `assertParsePrintCanonical`, `checkPrintParse`, and `checkCanonicalization`.
    The build now cleans `dist` first, so the package no longer ships stale
    modules, and a packaged-export test guards the published entry points.

## 0.4.0

### Minor Changes

- Rename the schema integration function from `toSchema` to `codec`.

## 0.3.0

### Minor Changes

- [#10](https://github.com/saiashirwad/effect-grammar/pull/10)
  [`ff8976e`](https://github.com/saiashirwad/effect-grammar/commit/ff8976e3330802a86cb3514d9672836e745cb536)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Lean core: remove the
  self-healing printer and context-dependent features

  The printer no longer searches for derivations of missing bindings. Every
  binding a `gen` parses must appear in its return exactly once, and printing a
  value without that binding fails with a structured `MissingBinding` error.

  Removed: print-time recovery (`recoverableRefs`, transitive recovery), the
  `Dependent` node and `dependent` combinator, `transformOrFail`'s separate node
  (merged into `Transform`; both combinators remain), the construction-time
  `nullable` analysis (the parser's zero-width guard remains), `toEBNF` and
  `UnsupportedGrammar` (use `render`), and the `caseOf` / `when` combinators
  (`matchValue` covers literal keys).

  Performance: printing no longer runs a recovery search per `gen` step, literal
  parsing uses `String.prototype.startsWith` on the fast path, slot reads no
  longer allocate `Option`s, `gen` frames are packed arrays, and ref proxies
  share one handler. On identical workloads: parsing is ~1.4x faster and
  printing ~1.8x faster than the previous release.

- [`277b09f`](https://github.com/saiashirwad/effect-grammar/commit/277b09f30cd26d770c253930854a5b54f3633aff)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Stage `Grammar.gen`:
  the generator runs once, at construction, and builds a static grammar.

  Breaking:

  - `yield*` on a value grammar returns a `Ref<A>`, a symbolic reference, not a
    value. `field` is gone: the generator's return (a ref, a plain object, an
    array, or constants over them) is the pattern the parser fills and the
    printer reads. Every binding must be returned exactly once, or recovered by
    a later step; `gen` throws otherwise.
  - JavaScript control flow on a parsed value (`if (kind === "num")`) no longer
    works, since there is no value yet. Use `match`, `when`, `matchValue`, or
    `caseOf`. A property of a ref (`header.kind`) is a ref to that property;
    `get` handles reserved property names.
  - `Grammar<A>` is invariant. The interpreter AST and `.node` are no longer
    public.
  - `lexeme` consumes trailing trivia and prints none. Use `space` or `spaces`
    for canonical spacing. `whitespace` is replaced by `trivia`.
  - `seq` takes silent grammars only. `Field`, `Fields`, and `Part` are removed.

  Added lexical refs, transitive recovery, direct `take` and exact-repeat nodes,
  `transformOrFail`, structured `PrintIssue` errors, `toEBNF`, `defaulted`,
  `between`, `struct`, `tuple`, `taggedChoice`, and data-last delimiter
  combinators.

## 0.2.0

### Minor Changes

- Update documentation and package description.

## 0.1.0

### Minor Changes

- [#4](https://github.com/saiashirwad/effect-grammar/pull/4)
  [`44a67b6`](https://github.com/saiashirwad/effect-grammar/commit/44a67b63e9a38dc939216f3e78c0bea0040c1e6e)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Add the schema-backed
  `Grammar.mapSchema` API for typed, validated mappings.

- [`6bff47a`](https://github.com/saiashirwad/effect-grammar/commit/6bff47a638d016c53292e04ac135c753245bd85d)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Rebuild the library
  around a bidirectional `Grammar.gen`.

  Breaking:

  - The `effect-grammar/parser` entry (parse-only Effect combinators),
    `fromEffect`, and streaming (`parseStream`, `streamElements`) are removed.
  - `struct` + `map`/`mapSchema` are replaced by `gen`/`seq` with `field`, and
    `transform`/`decodeTo`. Silent grammars (`literal`, `symbol`, `skip`) carry
    no value.
  - `attempt`, `bind`, `count`, `guard`, `between`, `end`, `parsePrefix`, `lazy`
    are removed or renamed (`wrap`/`prefix`/`suffix`, `many({ min, max })`,
    `suspend`).
  - `parse`/`print` are synchronous and return `Result`; `choice` backtracks
    fully and errors report the furthest failure with every expectation merged.

## 0.0.2

### Patch Changes

- [`d140b3f`](https://github.com/saiashirwad/effect-grammar/commit/d140b3fdd457709308a61cb85ae72fe86af67e42)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Document strict
  parsing and the `parsePrefix` escape hatch.
