---
"effect-grammar": minor
---

Add `effect-grammar/Binary` for native Uint8Array parsing and printing: byte
literals, signed and unsigned 8/16/32/64-bit integers and floats in both byte
orders (`B.be`, `B.le`), LEB128 varints, fixed and dependent byte lengths, UTF-8
by byte length, bit fields, byte offset errors, `B.compile`, and a
`Schema.Uint8Array` `codec`. Binary grammars reuse the existing composition and
round-trip checks; `lawsFor(B.format)` in `effect-grammar/testing` binds the law
helpers to bytes.

`G.mapRef(ref, f)` computes from a ref, and `G.derive(target, source)` lets a
gen check a binding in both directions and compute it on print, so length
prefixes can be left out of values. `take` and `repeat` also accept a static
count, and `validate` reports terminals that read a different kind of input,
matching what `compile` rejects.

Also visible: `Compiled` gained input and error type parameters with defaults
that keep `Compiled<A>` unchanged; the `RoundTrip` print issue's `printed` is
now `string | Uint8Array`; `effect-grammar/testing` exports `lawsFor(format)`
and the `Format` type; the binary error class is `BinaryParseError`, exported
from the Binary module as both `BinaryParseError` and `ParseError`.
