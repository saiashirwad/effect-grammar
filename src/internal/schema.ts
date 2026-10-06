import { Effect, flow, type Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Domain, Grammar } from "../core.ts"
import { formatIssue, type ParseError, type PrintError, type PrintIssue } from "../errors.ts"
import { valueSchema } from "./derive.ts"

export interface CodecOptions {
  readonly identifier?: string
}

const toSchemaIssue = (issue: PrintIssue): SchemaIssue.Issue =>
  issue._tag === "AtPath"
    ? new SchemaIssue.Pointer([issue.path], toSchemaIssue(issue.issue))
    : new SchemaIssue.InvalidValue({ message: formatIssue(issue) })

export const codecWith = <Input extends Schema.Top, D extends Domain>(
  source: Input,
  domain: D,
  parse: <A>(grammar: Grammar<A, D>, input: Input["Type"]) => Result.Result<A, ParseError>,
  print: <A>(grammar: Grammar<A, D>, value: A) => Result.Result<Input["Type"], PrintError>,
) => {
  const adapt = <S extends Schema.Top, A extends S["Encoded"]>(
    grammar: Grammar<A, D>,
    target: S,
    options: CodecOptions | undefined,
  ) =>
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
      Schema.annotate({ identifier: options?.identifier }),
    )

  /** Derives the value schema from the grammar; every transform on the way must declare `to`. */
  function codec<A>(grammar: Grammar<A, D>, options?: CodecOptions): Schema.Codec<A, Input["Type"]>
  /** Decodes parsed values through an explicit target schema, with its transformations and services. */
  function codec<S extends Schema.Top, A extends S["Encoded"]>(
    grammar: Grammar<A, D>,
    target: S,
    options?: CodecOptions,
  ): Schema.decodeTo<S, Input>
  function codec<A>(
    grammar: Grammar<A, D>,
    targetOrOptions?: Schema.Top | CodecOptions,
    options?: CodecOptions,
  ): Schema.Top {
    if (Schema.isSchema(targetOrOptions)) return adapt(grammar, targetOrOptions, options)
    // SAFETY: the derived schema describes exactly the values the grammar parses, which are A.
    const target = valueSchema(grammar, domain) as Schema.Codec<A>
    return adapt(grammar, target, targetOrOptions)
  }
  return codec
}
