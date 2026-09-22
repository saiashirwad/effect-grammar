---
"effect-grammar": minor
---

Simplify the API around fewer concepts.

- `Silent` is gone. A grammar that produces nothing is `Grammar<void>`. `gen`
  binds every `yield*`; a step the return value does not mention prints with
  `undefined`. `diagnose` reports omitted steps whose output is not structurally
  syntax-only. Return opaque values or discard them with `skip`.
- Every combinator that takes an inner grammar is pipe-only:
  `inner.pipe(many())`, `inner.pipe(between("(", ")"))`,
  `inner.pipe(transform(...))`. Data-first forms are removed.
- `choiceOn`, `choiceOnEntries`, and `matchValue` are replaced by `dispatch` and
  `match`, which take `[key, grammar]` entries; `taggedChoice` takes entries
  too. Integer-like keys are allowed. `taggedChoice` is derived from `dispatch`
  and `transformOrFail`, so empty or duplicate cases report `dispatch` errors.
- `choice` takes a nonempty readonly tuple of branches and optional
  `ChoiceOptions`: `choice([a, b], { print: "roundTrip" })`. The default
  `"first"` policy accepts the first printable candidate. The `"roundTrip"`
  policy replaces the separate checked-choice constructor and searches for a
  candidate that parses back equally through the choice.
- `between`, `prefix`, and `suffix` use `gen` sequences with a whole-ref result.
  Their diagnostic paths now use `steps` instead of opening, inner, and closing
  wrapper edges. Supplied syntax keeps its original print failure instead of an
  omitted-value error. Syntax-only generators can return a whole syntax-step
  ref.
- Transforms no longer take `is` or `name`. Use `filter(predicate, name)` for
  guards and `label(name)` to name a grammar. `transformOrFail` fails with a
  string. `decodeTo` is removed. Use `transform(...)` followed by
  `filter(Schema.is(schema), name)` for a schema guard.
- Transformations use `transform` or `transformOrFail`; `iso`, `partialIso`,
  `Fidelity`, and `auditFidelity` are removed.
- `print` now checks that its output parses back to an equal value. The previous
  unchecked printer is `printUnchecked`; `printChecked` is removed. This applies
  to text and Binary. The `"roundTrip"` choice policy searches for a branch that
  round-trips even under `printUnchecked`.
- `regex(re, name)` is `regex(re).pipe(label(name))`; `take` has no byte unit.
  Use `Binary.bytes(count)` for a `Uint8Array`. Raw byte-string readers are
  private.
- One `ParseError`: `Binary.parse` returns it with `line` and `column` undefined
  and `pos` as a byte offset.
- `Binary.Bit`, `Uint`, `Int`, `Uint8`…`Int64` are `bitSchema`, `uintSchema(n)`,
  `intSchema(n)`, `uint64Schema`, `int64Schema`.
- `prepare`, `Prepared`, and `GrammarValidationError` are removed; use
  `diagnose` with the parse and print functions. `diagnose` replaces `validate`
  without an alias. Issues have a stable `_tag`, grammar-graph `path`, and
  `message`. Diagnostics inspect structure without running encode, decode, or
  predicate callbacks. Suspended thunk failures become issues.
- `describe` now gives a shallow name without expanding children or resolving
  suspensions. Use `render` for full grammar notation.
- Import `codec` and `CodecOptions` from `effect-grammar/Schema`, not the root.
  `Binary.codec` uses the same Schema integration with byte input and output.
- The printer's recursion guard now catches a suspended grammar re-entered with
  the same value at any depth, so a recursive branch that cannot make progress
  falls through to the next branch instead of overflowing the stack.
