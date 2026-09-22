---
"effect-grammar": minor
---

Reorganize the library around a smaller node set and a clearer file layout.

- `optional` is now a plain function: use `.pipe(optional)` instead of
  `.pipe(optional())`.
- `Prepared.fidelity` is renamed to `Prepared.audit`.
- The `effect-grammar/Schema` subpath is removed; `codec` is exported from the
  root as before.
- The printer's recursion guard now detects a suspended grammar re-entered with
  the same value at any depth, not only when nested directly.
