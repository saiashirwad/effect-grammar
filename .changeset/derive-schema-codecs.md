---
"effect-grammar": minor
---

Derive complete Schema codecs from grammars.

- `GrammarSchema.codec(grammar)` returns a `Schema.Codec<A, string>` and
  `Binary.codec(grammar)` returns a `Schema.Codec<A, Uint8Array>`. The value
  schema is derived from the grammar: structure, constants, choices, dispatch,
  repetition bounds, labels, filters, recursion, and the built-in terminals need
  no annotations. Dependencies inside a `gen` (`take`, `repeat`, `match`) become
  checks reported at the dependent value's path.
- `transform` and `transformOrFail` accept an optional `to` schema describing
  their output. `codec(grammar)` requires it on every custom transform and
  throws an error naming the transform and its path when it is missing. Parsing
  and printing ignore `to`.
- `codec(grammar, target, options?)` is unchanged.
- Parse errors for throwing filter predicates name the filtered grammar.
