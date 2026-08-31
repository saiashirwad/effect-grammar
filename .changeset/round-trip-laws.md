---
"effect-grammar": minor
---

Make the round-trip law first-class, and ship the testing, validation, and
packaging around it.

- Add `printChecked`, which prints a value, parses the output back, and fails
  unless it reads as an equal value. This is the whole-grammar round-trip
  guarantee. `print` stays unchecked.
- Replace `print(grammar, value, { verify: true })` with per-choice printer
  selection: `checkedChoice(...branches)` or
  `choice(..., { printSelection: "roundTrip" })` picks the first branch whose
  text parses back. The old `verify` option, which never checked dispatched
  (`choiceOn`) choices, is gone.
- `codec` verifies the round trip on encode by default; pass
  `{ roundTrip: "off" }` to skip it.
- `choiceOn` now also accepts an array of `[key, grammar]` entries for an
  explicit parse order and number or boolean discriminants. The object form
  still works and still rejects integer-like keys.
- Distinguish transformations by the law they claim: `iso` (claimed inverse),
  `partialIso` (fallible, agrees where both succeed), and `decodeTo` (Schema
  guarded) alongside the law-free `transform` and `transformOrFail`.
  `auditFidelity` lists the transforms that claim no inverse.
- Add `validate` and `compile` to catch staged errors — refs used outside their
  gen, duplicate discriminant keys, unbounded repetition of an empty-matching
  grammar — before parse or print.
- Add the `effect-grammar/testing` export with `assertPrintParse`,
  `assertParsePrintCanonical`, `checkPrintParse`, and `checkCanonicalization`.
  The build now cleans `dist` first, so the package no longer ships stale
  modules, and a packaged-export test guards the published entry points.
