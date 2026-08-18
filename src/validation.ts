import { Data } from "effect"

export class InvalidCardinalityError extends RangeError {}

export class InvalidIntegerError extends RangeError {}

export class EvaluationError extends Data.TaggedError("EvaluationError")<{
  readonly cause: unknown
}> {}

export const validateNonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidCardinalityError(`${name} requires a non-negative safe integer`)
  }
  return value
}
