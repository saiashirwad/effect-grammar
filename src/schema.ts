import { Effect, Equal, Option, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import type { Grammar } from "./core.ts"
import { RoundTripError } from "./errors.ts"
import { parse } from "./parse.ts"
import { preview, print } from "./print.ts"
import { render } from "./render.ts"

export const checkRoundTrip = <A>(
  grammar: Grammar<A>,
  value: A,
): Result.Result<void, RoundTripError> => {
  const printed = print(grammar, value)
  if (Result.isFailure(printed)) {
    return Result.fail(new RoundTripError({ stage: "print", message: printed.failure.message }))
  }
  const reparsed = parse(grammar, printed.success)
  if (Result.isFailure(reparsed)) {
    return Result.fail(
      new RoundTripError({
        stage: "parse",
        message: `${reparsed.failure.message}\n  printed: ${JSON.stringify(printed.success)}`,
      }),
    )
  }
  if (!Equal.equals(reparsed.success, value)) {
    return Result.fail(
      new RoundTripError({
        stage: "equal",
        message:
          `original: ${preview(value)}` +
          `\n  reparsed: ${preview(reparsed.success)}` +
          `\n  printed:  ${JSON.stringify(printed.success)}`,
      }),
    )
  }
  return Result.void
}

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
    Schema.annotate({
      ...(options?.identifier === undefined ? {} : { identifier: options.identifier }),
      description: render(grammar),
    }),
  )
