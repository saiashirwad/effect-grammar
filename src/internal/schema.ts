import { Effect, flow, type Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Domain, Grammar } from "../core.ts"
import { formatIssue, type ParseError, type PrintError, type PrintIssue } from "../errors.ts"
import { render } from "../render.ts"

export interface CodecOptions {
  readonly identifier?: string
}

const toSchemaIssue = (issue: PrintIssue): SchemaIssue.Issue =>
  issue._tag === "AtPath"
    ? new SchemaIssue.Pointer([issue.path], toSchemaIssue(issue.issue))
    : new SchemaIssue.InvalidValue({ message: formatIssue(issue) })

export const codecWith = <Input extends Schema.Top, D extends Domain>(
  source: Input,
  parse: <A>(grammar: Grammar<A, D>, input: Input["Type"]) => Result.Result<A, ParseError>,
  print: <A>(grammar: Grammar<A, D>, value: A) => Result.Result<Input["Type"], PrintError>,
) =>
<S extends Schema.Top, A extends S["Encoded"]>(grammar: Grammar<A, D>, target: S, options?: CodecOptions) =>
  source.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], Input["Type"]>({
        decode: flow(
          (input) => parse(grammar, input),
          Effect.fromResult,
          Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message })),
        ),
        encode: flow(
          // SAFETY: the target schema encodes to A.
          (value) => print(grammar, value as A),
          Effect.fromResult,
          Effect.mapError(({ issue }) => toSchemaIssue(issue)),
        ),
      }),
    ),
    Schema.annotate({ identifier: options?.identifier, description: render(grammar) }),
  )
