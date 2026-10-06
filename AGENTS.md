# Repository rules

| Rule                                                                                                                                                                                                           | Enforcement                                                                                                                                                       | Evidence                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| In `examples/`, define grammar-owned object structure with `Grammar.gen`, then derive codecs with `GrammarSchema.codec` and value schemas with `Schema.toType`. Do not restate it with Effect `Schema.Struct`. | `anti-slop/no-example-schema-struct` in `oxlint.config.ts`, exercised by `test/example-schema-struct-lint.test.ts`; `pnpm check` runs lint and tests, as does CI. | `6a1c0c2` removed `ConnectionInfo` from connection-string; `3cd7935` removed parallel object schemas from scheme and github-search. |

This is an example-authoring constraint, not a library API restriction. Explicit
schema targets remain supported by the library and its tests. Semantic scalar
schemas, JSON `Schema.Record`, and external API `Schema.Union` are not
structural restatements and must remain usable. The lint rule detects direct
calls through Effect imports (including import aliases and static computed
property access); it does not attempt whole-program alias or data-flow analysis.
There are no rule-specific exceptions or allowlists.
