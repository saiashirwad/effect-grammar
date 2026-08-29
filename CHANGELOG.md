# effect-grammar

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
