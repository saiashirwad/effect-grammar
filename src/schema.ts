import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar, Value } from "./core.ts"
import type { PrintIssue } from "./errors.ts"
import { PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"
import { render } from "./render.ts"

const printIssueToSchema = (actual: Value, issue: PrintIssue): SchemaIssue.Issue => {
  if (issue._tag === "AtPath") {
    return new SchemaIssue.Pointer([issue.path], printIssueToSchema(actual, issue.issue))
  }
  return new SchemaIssue.InvalidValue({ message: PrintError.format(issue) }, actual)
}

export interface CodecOptions {
  readonly identifier?: string
  /**
   * - `verify` (default): encoding prints, then parses the output back and
   *   fails if it decodes to a different value, so a codec never encodes a
   *   valid value into text that decodes as another. Reparses on every encode.
   * - `off`: encoding prints without the check.
   */
  readonly roundTrip?: "verify" | "off"
}

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) => {
  const print = options?.roundTrip === "off" ? printUnknown : printCheckedUnknown
  return Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], string>({
        decode: (text) =>
          Effect.fromResult(parse(grammar, text)).pipe(
            Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message }, text)),
          ),
        encode: (value) =>
          Effect.fromResult(print(grammar, value)).pipe(
            Effect.mapError((error) => printIssueToSchema(value, error.issue)),
          ),
      }),
    ),
    Schema.annotate({ identifier: options?.identifier, description: render(grammar) }),
  )
}
