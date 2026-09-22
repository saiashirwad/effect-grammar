import { Result } from "effect"

import type { Value } from "../core.ts"
import { exceptionMessage, type PrintIssue } from "../errors.ts"

/** Interpretation boundaries only: construction errors must remain visible. */
export const catchResult = <A, E>(
  run: () => Result.Result<A, E>,
  onException: (error: Value) => E,
): Result.Result<A, E> => {
  try {
    return run()
  } catch (error) {
    return Result.fail(onException(error))
  }
}

export const inspect = <A>(
  actual: Value,
  expected: string,
  read: () => A,
  detail: (message: string) => string = (message) => message,
): Result.Result<A, PrintIssue> =>
  catchResult(
    () => Result.succeed(read()),
    (error): PrintIssue => ({ _tag: "InvalidValue", expected, actual, detail: detail(exceptionMessage(error)) }),
  )

export const atPath = <A>(path: string | number, result: Result.Result<A, PrintIssue>): Result.Result<A, PrintIssue> =>
  Result.mapError(result, (issue) => ({ _tag: "AtPath", path, issue }))
