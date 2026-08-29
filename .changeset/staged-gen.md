---
"effect-grammar": minor
---

Stage `Grammar.gen`: the generator runs once, at construction, and builds a
static grammar.

Breaking:

- `yield*` on a value grammar returns a `Ref<A>`, a symbolic reference, not a
  value. `field` is gone: the generator's return (a ref, a plain object, an
  array, or constants over them) is the pattern the parser fills and the printer
  reads. Every binding must be returned exactly once, or recovered by a later
  step; `gen` throws otherwise.
- JavaScript control flow on a parsed value (`if (kind === "num")`) no longer
  works, since there is no value yet. Use `match(ref, cases)`, which the printer
  inverts. A property of a ref (`header.kind`) is a ref to that property.
- `seq` takes silent grammars only. `Field`, `Fields`, and `Part` are removed.

Added: `match`, `take`, `repeat`, `dependent`, and the `Ref`, `Denote`,
`Pattern`, `Step`, `Expr` types. `render` names bindings by their path in the
return and shows `match` and dependent grammars.
