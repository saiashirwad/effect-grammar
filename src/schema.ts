import { Effect, flow, type Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar, GrammarInternal } from "./core.ts"
import { PrintError, type PrintIssue } from "./errors.ts"
import { parse } from "./parse.ts"
import { printCheckedUnknown } from "./print.ts"
import { render } from "./render.ts"

export interface CodecOptions {
  readonly identifier?: string
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
        decode: flow(
          parse,
          Effect.fromResult,
          Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message })),
        ),
        encode: flow(
          print,
          Effect.fromResult,
          Effect.mapError(({ issue }) => {
            const toSchema = (issue: PrintIssue): SchemaIssue.Issue =>
              issue._tag === "AtPath"
                ? new SchemaIssue.Pointer([issue.path], toSchema(issue.issue))
                : new SchemaIssue.InvalidValue({ message: PrintError.format(issue) })

            return toSchema(issue)
          }),
        ),
      }),
    ),
    Schema.annotate({ identifier, description: render(grammar) }),
  )

// Decoding consumes the whole string. Encoding always checks round trips.
export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) =>
  codecFrom(
    Schema.String,
    target,
    grammar,
    options?.identifier,
    (text) => parse(grammar, text),
    (value) => printCheckedUnknown(grammar, value),
  )
