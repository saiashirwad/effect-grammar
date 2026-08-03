/**
 * Primary entry: the bidirectional Grammar layer.
 * Parse-only Effect combinators live at `effect-grammar/parser`
 * (avoids a second top-level `parse` with a different return type).
 */
export * as Grammar from "./grammar.ts"
