---
"effect-grammar": minor
---

Round out the binary number grammars and add two small combinators.

- `effect-grammar/Binary` adds `int8` to `int64`, `uint64`, `float32`,
  `float64`, their `le` variants, and the LEB128 `varuint` and zigzag `varint`,
  with the `Int`, `Int8`, `Int16`, `Int32`, `Uint64`, and `Int64` schemas.
  64-bit integers are bigints.
- `repeat` accepts a constant count as well as a ref, and `validate` can prove
  that `repeat(item, 0)` matches empty input.
- Add `literals`, an ordered choice of strings whose value is the matched
  string.
- Print errors show a `Uint8Array` as hex instead of as an indexed object.
