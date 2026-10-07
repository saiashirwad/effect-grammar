# Repository rules

- **Derive grammar-owned structure in examples.**
  - In `examples/`, define object structure with `Grammar.gen`, then derive
    codecs with `GrammarSchema.codec` and value schemas with `Schema.toType`. Do
    not restate it with Effect `Schema.Struct`.
  - **Enforcement:** `anti-slop/no-example-schema-struct` in `oxlint.config.ts`,
    exercised by `test/example-schema-struct-lint.test.ts`; `pnpm check` runs
    lint and tests, as does CI.
  - **Scope:** This is an example-authoring constraint, not a library API
    restriction. Explicit schema targets remain supported by the library and its
    tests. Semantic scalar schemas, JSON `Schema.Record`, and external API
    `Schema.Union` remain usable.
  - **Limits:** The lint rule detects direct calls through Effect imports,
    including import aliases and static computed property access. It does not
    attempt whole-program alias or data-flow analysis. There are no
    rule-specific exceptions or allowlists.
- **Use Effect services for test I/O.**
  - Use Effect `FileSystem`, `Path`, and `ChildProcess` services with scoped
    resource cleanup; run tests through `@effect/vitest` `it.effect`.
  - **Enforcement:** `effecttsgo/node-builtin-import` is an error in
    `oxlint.config.ts`, enforced by `pnpm check` and CI. Review enforces
    `it.effect` and scoped cleanup; the import rule does not cover them.
- **Preserve natural query parameter values.**
  - Preserve ordered query pairs, duplicate keys, and absent versus empty
    queries in the examples.
  - **Enforcement:** `test/query-examples.test.ts` exercises the same pure
    grammar modules imported by the demos; `pnpm check` and CI run it.
