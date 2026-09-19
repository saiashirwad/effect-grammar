---
"effect-grammar": minor
---

Round out the binary number grammars and add two small combinators.

- `effect-grammar/Binary` adds `int8` to `int64`, `uint64`, `float32`,
  `float64`, their `le` variants, and the LEB128 `varuint` and zigzag `varint`,
  with the `Int`, `Int8`, `Int16`, `Int32`, `Uint64`, and `Int64` schemas.
  64-bit integers are bigints.
- `repeat` accepts a constant count as well as a ref. `validate` can prove that
  `repeat(item, 0)` matches empty input, and reports any other `repeat` whose
  item matches empty input, as it does for `many`.
- Add `literals`, a choice of strings whose value is the matched string. Longer
  strings are tried first, so none is shadowed by its own prefix.
- `validate` sees through transforms: one over a grammar that cannot match empty
  input cannot either, and `as`, `flag`, and `literals` match empty input when
  their literal does.
- Print errors show a `Uint8Array` or `Buffer` as `<07 ab>` and a bigint as
  `5n`, at any depth in the value, instead of an indexed object or
  `[object Object]`. A byte run of the wrong length reports its bytes rather
  than a binary string.
