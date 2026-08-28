# effect-grammar

## 0.1.0

### Minor Changes

- [#4](https://github.com/saiashirwad/effect-grammar/pull/4) [`44a67b6`](https://github.com/saiashirwad/effect-grammar/commit/44a67b63e9a38dc939216f3e78c0bea0040c1e6e) Thanks [@saiashirwad](https://github.com/saiashirwad)! - Add the schema-backed `Grammar.mapSchema` API for typed, validated mappings.

- [`6bff47a`](https://github.com/saiashirwad/effect-grammar/commit/6bff47a638d016c53292e04ac135c753245bd85d) Thanks [@saiashirwad](https://github.com/saiashirwad)! - Rebuild the library around a bidirectional `Grammar.gen`.

  Breaking:

  - The `effect-grammar/parser` entry (parse-only Effect combinators),
    `fromEffect`, and streaming (`parseStream`, `streamElements`) are removed.
  - `struct` + `map`/`mapSchema` are replaced by `gen`/`seq` with `field`, and
    `transform`/`decodeTo`. Silent grammars (`literal`, `symbol`, `skip`) carry no
    value.
  - `attempt`, `bind`, `count`, `guard`, `between`, `end`, `parsePrefix`, `lazy`
    are removed or renamed (`wrap`/`prefix`/`suffix`, `many({ min, max })`,
    `suspend`).
  - `parse`/`print` are synchronous and return `Result`; `choice` backtracks fully
    and errors report the furthest failure with every expectation merged.

## 0.0.2

### Patch Changes

- [`d140b3f`](https://github.com/saiashirwad/effect-grammar/commit/d140b3fdd457709308a61cb85ae72fe86af67e42)
  Thanks [@saiashirwad](https://github.com/saiashirwad)! - Document strict
  parsing and the `parsePrefix` escape hatch.
