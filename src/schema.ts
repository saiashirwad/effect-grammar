import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar, Value } from "./core.ts"
import type { PrintIssue } from "./errors.ts"
import { PrintError } from "./errors.ts"
import { type Format, type Input, textFormat } from "./format.ts"
import { parseWith } from "./parse.ts"
import { printCheckedWith, printWith } from "./print.ts"
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

export const codecWith = <S extends Schema.Top, A extends S["Encoded"], I extends Input>(
  grammar: Grammar<A>,
  target: S,
  format: Format<I, Error>,
  options?: CodecOptions,
) => {
  const print = options?.roundTrip === "off" ? printWith : printCheckedWith
  return format.schema.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], I>({
        decode: (input) =>
          Effect.fromResult(parseWith(grammar, input, format)).pipe(
            Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message }, input)),
          ),
        encode: (value) =>
          Effect.fromResult(print(grammar, value, format)).pipe(
            Effect.mapError((error) => printIssueToSchema(value, error.issue)),
          ),
      }),
    ),
    Schema.annotate({ identifier: options?.identifier, description: render(grammar) }),
  )
}

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) => codecWith(grammar, target, textFormat, options)
