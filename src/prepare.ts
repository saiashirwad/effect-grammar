import { Result } from "effect"

import { auditFidelity, type FidelityEntry, validate } from "./analysis.ts"
import type { Grammar } from "./core.ts"
import type { ParseError, PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { print, printChecked } from "./print.ts"
import { render } from "./render.ts"

export interface Prepared<A> {
  readonly parse: (text: string) => Result.Result<A, ParseError>
  readonly print: (value: A) => Result.Result<string, PrintError>
  readonly printChecked: (value: A) => Result.Result<string, PrintError>
  readonly render: string
  readonly fidelity: ReadonlyArray<FidelityEntry>
}

/**
 * Validate a grammar once, then return interpreter functions bound to it.
 * This does not compile or optimize the grammar. Validation can resolve and
 * cache suspended thunks, and throws if {@link validate} finds an issue. Other
 * input, value, callback, and round-trip failures can still occur at runtime.
 */
export const prepare = <A>(grammar: Grammar<A>): Prepared<A> => {
  const issues = validate(grammar)
  if (issues.length > 0) {
    throw new Error(
      `prepare: the grammar has ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n  ${issues
        .map((issue) => issue.message)
        .join("\n  ")}`,
    )
  }
  return {
    parse: (text) => parse(grammar, text),
    print: (value) => print(grammar, value),
    printChecked: (value) => printChecked(grammar, value),
    render: render(grammar),
    fidelity: auditFidelity(grammar),
  }
}
