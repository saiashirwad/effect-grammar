---
"effect-grammar": major!
---

Lean core: remove the self-healing printer and context-dependent features

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
longer allocate `Option`s, `gen` frames are packed arrays, and ref proxies share
one handler. On identical workloads: parsing is ~1.4x faster and printing ~1.8x
faster than the previous release.
