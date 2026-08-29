import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar, Value } from "./core.ts"
import type { PrintIssue } from "./errors.ts"
import { PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { printUnknown } from "./print.ts"
import { render } from "./render.ts"

const printIssueToSchema = (actual: Value, issue: PrintIssue): SchemaIssue.Issue => {
  if (issue._tag === "AtPath") {
    return new SchemaIssue.Pointer([issue.path], printIssueToSchema(actual, issue.issue))
  }
  return new SchemaIssue.InvalidValue({ message: PrintError.format(issue) }, actual)
}

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: { readonly identifier?: string },
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], string>({
        decode: (text) =>
          Effect.fromResult(parse(grammar, text)).pipe(
            Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message }, text)),
          ),
        encode: (value) =>
          Effect.fromResult(printUnknown(grammar, value)).pipe(
            Effect.mapError((error) => printIssueToSchema(value, error.issue)),
          ),
      }),
    ),
    Schema.annotate({ ...options, description: render(grammar) }),
  )
