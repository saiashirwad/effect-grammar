import { Effect, type Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { GrammarInternal, Value } from "./core.ts"
import type { PrintIssue } from "./errors.ts"
import { PrintError } from "./errors.ts"
import { render } from "./render.ts"

const printIssueToSchema = (actual: Value, issue: PrintIssue): SchemaIssue.Issue => {
  if (issue._tag === "AtPath") {
    return new SchemaIssue.Pointer([issue.path], printIssueToSchema(actual, issue.issue))
  }
  return new SchemaIssue.InvalidValue({ message: PrintError.format(issue) }, actual)
}

export interface CodecOptions {
  readonly identifier?: string
  // - `verify` (default): reparse every encoded output and fail if the value changes.
  // - `off`: print without checking the round trip.
  readonly roundTrip?: "verify" | "off"
}

export const codecFrom = <I, S extends Schema.Top>(
  source: Schema.Codec<I>,
  target: S,
  grammar: GrammarInternal,
  identifier: string | undefined,
  parse: (input: I) => Result.Result<S["Encoded"], { readonly message: string }>,
  print: (value: S["Encoded"]) => Result.Result<I, PrintError>,
) =>
  source.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], I>({
        decode: (input) =>
          Effect.fromResult(parse(input)).pipe(
            Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message }, input)),
          ),
        encode: (value) =>
          Effect.fromResult(print(value)).pipe(
            Effect.mapError((error) => printIssueToSchema(value, error.issue)),
          ),
      }),
    ),
    Schema.annotate({ identifier, description: render(grammar) }),
  )
