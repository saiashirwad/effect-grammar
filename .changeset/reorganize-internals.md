---
"effect-grammar": minor
---

Simplify the API around fewer concepts.

- `Silent` is gone. A grammar that produces nothing is `Grammar<void>`. `gen`
  binds every `yield*`; a step the return value does not mention prints with
  `undefined`, and `validate` reports steps that cannot.
- Every combinator that takes an inner grammar is pipe-only:
  `inner.pipe(many())`, `inner.pipe(between("(", ")"))`, `inner.pipe(iso(...))`.
  Data-first forms are removed.
- `choiceOn`, `choiceOnEntries`, and `matchValue` are replaced by `dispatch` and
  `match`, which take `[key, grammar]` entries; `taggedChoice` takes entries
  too. Integer-like keys are allowed.
- Transforms no longer take `is` or `name`. Use `filter(predicate, name)` for
  guards and `label(name)` to name a grammar. `transformOrFail` and `partialIso`
  fail with a string. `decodeTo(schema, name?)` applies the schema guard.
- `regex(re, name)` is `regex(re).pipe(label(name))`; `take` has no byte unit.
  `Binary.takeBytes` replaces `takeBytes`.
- One `ParseError`: `Binary.parse` returns it with `line` and `column` undefined
  and `pos` as a byte offset.
- `Binary.Bit`, `Uint`, `Int`, `Uint8`…`Int64` are `bitSchema`, `uintSchema(n)`,
  `intSchema(n)`, `uint64Schema`, `int64Schema`.
- `prepare`, `Prepared`, and `GrammarValidationError` are removed; use
  `validate` with the parse and print functions.
- The `effect-grammar/Schema` subpath is removed; `codec` is on the root.
- The printer's recursion guard now catches a suspended grammar re-entered with
  the same value at any depth, so a recursive branch that cannot make progress
  falls through to the next branch instead of overflowing the stack.
