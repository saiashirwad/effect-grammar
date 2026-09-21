import { Result, Schema } from "effect"

import { auditFidelity, type FidelityEntry, validate } from "./analysis.ts"
import type { Grammar, GrammarIssue } from "./core.ts"
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

export class GrammarValidationError extends Schema.TaggedError<GrammarValidationError>()(
  "GrammarValidationError",
  {
    issues: Schema.Array(Schema.Struct({ message: Schema.String })),
  },
) {
  declare readonly issues: ReadonlyArray<GrammarIssue>

  override get message(): string {
    return `prepare: the grammar has ${this.issues.length} issue${this.issues.length === 1 ? "" : "s"}:\n  ${this.issues
      .map((issue) => issue.message)
      .join("\n  ")}`
  }
}

/**
 * Validate a grammar once, then return interpreter functions bound to it in a
 * `Result`. Validation can resolve and cache suspended thunks. Other input,
 * value, callback, and round-trip failures can still occur when the prepared
 * operations run.
 *
 * This does not compile or optimize the grammar.
 */
export const prepare = <A>(
  grammar: Grammar<A>,
): Result.Result<Prepared<A>, GrammarValidationError> => {
  const issues = validate(grammar)
  if (issues.length > 0) {
    return Result.fail(new GrammarValidationError({ issues: [...issues] }))
  }
  return Result.succeed({
    parse: (text: string) => parse(grammar, text),
    print: (value: A) => print(grammar, value),
    printChecked: (value: A) => printChecked(grammar, value),
    render: render(grammar),
    fidelity: auditFidelity(grammar),
  })
}
