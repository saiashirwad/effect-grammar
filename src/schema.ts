import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar } from "./core.ts"
import { parse } from "./parse.ts"
import { print } from "./print.ts"
import { render } from "./render.ts"

export const toSchema = <S extends Schema.Top>(
  grammar: Grammar<S["Type"]>,
  target: S,
  options?: { readonly identifier?: string },
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail({
        decode: (s: string) =>
          Effect.fromResult(parse(grammar, s)).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue(Option.some(s), { message: e.message }),
            ),
          ),
        encode: (a: S["Type"]) =>
          Effect.fromResult(print(grammar, a)).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue(Option.some(a), { message: e.message }),
            ),
          ),
      }),
    ),
    Schema.annotate({ ...options, description: render(grammar) }),
  )
