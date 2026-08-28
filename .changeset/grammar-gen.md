---
"effect-grammar": minor
---

Rebuild the library around a bidirectional `Grammar.gen`.

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
