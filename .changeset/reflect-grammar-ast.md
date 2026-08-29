---
"effect-grammar": minor
---

Add `toAst` and `renderAst` for reflecting a grammar into a plain, JSON-shaped
tree. Scopes get stable names (`scope0`, `scope1`, …), bindings keep their
paths (`h.size`), recursive grammars are defined once with `SuspendRef` at the
recursion points, and functions are described by name. `renderAst` formats the
tree with one line per node.
