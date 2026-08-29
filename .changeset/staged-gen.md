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
  works, since there is no value yet. Use `match`, `when`, `matchValue`, or
  `caseOf`. A property of a ref (`header.kind`) is a ref to that property; `get`
  handles reserved property names.
- `Grammar<A>` is invariant. The interpreter AST and `.node` are no longer
  public.
- `lexeme` consumes trailing trivia and prints none. Use `space` or `spaces` for
  canonical spacing. `whitespace` is replaced by `trivia`.
- `seq` takes silent grammars only. `Field`, `Fields`, and `Part` are removed.

Added lexical refs, transitive recovery, direct `take` and exact-repeat nodes,
`transformOrFail`, structured `PrintIssue` errors, `toEBNF`, `defaulted`,
`between`, `struct`, `tuple`, `taggedChoice`, and data-last delimiter
combinators.
