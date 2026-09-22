import { Equal, Result } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import * as Bytes from "./binary.ts"
import type { Domain, Grammar } from "./core.ts"
import { type ParseError, preview, type PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { printUnchecked } from "./print.ts"

const lawError = (message: string): Error => new Error(`grammar law: ${message}`)

const laws = <D extends Domain, Input>(runners: {
  readonly parse: <A>(grammar: Grammar<A, D>, input: Input) => Result.Result<A, ParseError>
  readonly printUnchecked: <A>(grammar: Grammar<A, D>, value: A) => Result.Result<Input, PrintError>
  readonly show: (input: Input) => string
  readonly equals: (left: Input, right: Input) => boolean
}) => {
  const assertPrintParse = <A>(grammar: Grammar<A, D>, value: A): void => {
    const printed = runners.printUnchecked(grammar, value)
    if (Result.isFailure(printed)) {
      throw lawError(`parse(print(value)) = value fails: ${printed.failure.message}`)
    }
    const parsed = runners.parse(grammar, printed.success)
    if (Result.isFailure(parsed)) {
      throw lawError(
        `parse(print(value)) = value fails: ${runners.show(printed.success)} does not parse: ${parsed.failure.message}`,
      )
    }
    if (!Equal.equals(parsed.success, value)) {
      throw lawError(
        `parse(print(value)) = value fails: ${runners.show(printed.success)} reads back as ${preview(parsed.success)}, expected ${preview(value)}`,
      )
    }
  }

  const assertCanonical = <A>(grammar: Grammar<A, D>, input: Input, value: A): Input => {
    // Check the round trip here so failures retain canonicalization-specific context.
    const canonical = runners.printUnchecked(grammar, value)
    if (Result.isFailure(canonical)) {
      throw lawError(
        `print(parse(input)) failed\n  input:  ${runners.show(input)}\n  parsed: ${preview(value)}\n  error:  ${canonical.failure.message}`,
      )
    }
    const reparsed = runners.parse(grammar, canonical.success)
    if (Result.isFailure(reparsed)) {
      throw lawError(
        `the canonical input does not parse\n  input:     ${runners.show(input)}\n  canonical: ${runners.show(canonical.success)}\n  error:     ${reparsed.failure.message}`,
      )
    }
    if (!Equal.equals(reparsed.success, value)) {
      throw lawError(
        `canonicalization changed the value\n  input:     ${runners.show(input)}\n  canonical: ${runners.show(canonical.success)}\n  before:    ${preview(value)}\n  after:     ${preview(reparsed.success)}`,
      )
    }
    const again = runners.printUnchecked(grammar, reparsed.success)
    if (Result.isFailure(again) || !runners.equals(again.success, canonical.success)) {
      throw lawError(
        `canonicalization is not idempotent\n  once:  ${runners.show(canonical.success)}\n  twice: ${Result.isFailure(again) ? again.failure.message : runners.show(again.success)}`,
      )
    }
    return canonical.success
  }

  const assertParsePrintCanonical = <A>(grammar: Grammar<A, D>, input: Input): Input => {
    const parsed = runners.parse(grammar, input)
    if (Result.isFailure(parsed)) {
      throw lawError(`parse failed for ${runners.show(input)}: ${parsed.failure.message}`)
    }
    return assertCanonical(grammar, input, parsed.success)
  }

  const checkPrintParse = <A>(
    grammar: Grammar<A, D>,
    arbitrary: FastCheck.Arbitrary<A>,
    params?: FastCheck.Parameters<[A]>,
  ): void => {
    FastCheck.assert(
      FastCheck.property(arbitrary, (value) => assertPrintParse(grammar, value)),
      params,
    )
  }

  const checkCanonicalization = <A>(
    grammar: Grammar<A, D>,
    arbitraryInput: FastCheck.Arbitrary<Input>,
    params?: FastCheck.Parameters<[Input]>,
  ): void => {
    FastCheck.assert(
      FastCheck.property(arbitraryInput, (input) => {
        const parsed = runners.parse(grammar, input)
        if (Result.isFailure(parsed)) return FastCheck.pre(false)
        assertCanonical(grammar, input, parsed.success)
      }),
      params,
    )
  }

  return { assertPrintParse, assertParsePrintCanonical, checkPrintParse, checkCanonicalization }
}

export const { assertPrintParse, assertParsePrintCanonical, checkPrintParse, checkCanonicalization } = laws<
  "text",
  string
>({
  parse,
  printUnchecked,
  show: JSON.stringify,
  equals: (left, right) => left === right,
})

export const Binary = laws<"bytes", Uint8Array>({
  parse: Bytes.parse,
  printUnchecked: Bytes.printUnchecked,
  show: (input) => `hex[${Bytes.hex(input)}]`,
  equals: (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]),
})
