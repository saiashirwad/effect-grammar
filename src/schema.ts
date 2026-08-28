import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar } from "./core.ts"
import { parse } from "./parse.ts"
import { print } from "./print.ts"
import { render } from "./render.ts"

const issue = (input: unknown, message: string) =>
  new SchemaIssue.InvalidValue(Option.some(input), { message })

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
          Effect.fromResult(parse(grammar, s)).pipe(Effect.mapError((e) => issue(s, e.message))),
        encode: (a: S["Type"]) =>
          Effect.fromResult(print(grammar, a)).pipe(Effect.mapError((e) => issue(a, e.message))),
      }),
    ),
    Schema.annotate({ ...options, description: render(grammar) }),
  )
