---
"effect-grammar": minor
---

Add byte-oriented grammars and the combinators they needed.

- Add the `effect-grammar/Binary` export: `uint8`, `uint16`, `uint32`,
  `uint16le`, `uint32le`, `bits`, `bytes`, `lengthPrefixed`, `literal`, `ascii`,
  and `utf8`, with `parse`, `print`, `printChecked`, and `codec` over
  `Uint8Array`, the `Bit` and `Uint` schemas, and `hex`. Parse failures report a
  byte offset.
- `take` accepts a constant count as well as a ref.
- Add `lengthPrefixed` and `countPrefixed`, which derive the prefix from the
  value when printing.
- Add `filter`, which constrains a grammar's value with a predicate in both
  directions.
- Add `merge`, which flattens object grammars into one object and keeps flat
  field paths in print errors. Transform options accept `keys` so `merge` can
  see through a transform.
