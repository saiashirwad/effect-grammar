import { Effect, flow, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar } from "./core.ts"
import { toSchemaIssue } from "./errors.ts"
import { parse } from "./parse.ts"
import { print } from "./print.ts"
import { render } from "./render.ts"

export interface CodecOptions {
  readonly identifier?: string
}

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], string>({
        decode: flow(
          (text) => parse(grammar, text),
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
