import { Equal, Result } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import type { Grammar } from "./core.ts"
import { preview } from "./errors.ts"
import { type Format, type Input, textFormat } from "./format.ts"
import { parseWith } from "./parse.ts"
import { printCheckedWith, printWith } from "./print.ts"

/**
 * Law helpers for `Grammar`s. The library removes unbound whitespace, so its
 * grammars do not round-trip text exactly. Two laws hold instead:
 *
 * - `parse(print(value)) = value` — printing keeps a value's meaning.
 * - `print(parse(text)) = canonical(text)` — parsing then printing settles on
 *   one canonical form, and printing that form again does not change it.
 */

export type { Format } from "./format.ts"

const lawError = (message: string): Error => new Error(`grammar law: ${message}`)

export const lawsFor = <I extends Input>(format: Format<I, Error>) => {
  const assertCanonical = <A>(grammar: Grammar<A>, input: I, value: A): I => {
    const canonical = printWith(grammar, value, format)
    if (Result.isFailure(canonical)) {
      throw lawError(
        `print(parse(input)) failed\n  input:  ${preview(input)}\n  parsed: ${preview(value)}\n  error:  ${canonical.failure.message}`,
      )
    }
    const reparsed = parseWith(grammar, canonical.success, format)
    if (Result.isFailure(reparsed)) {
      throw lawError(
        `the canonical form does not parse\n  input:     ${preview(input)}\n  canonical: ${preview(canonical.success)}\n  error:     ${reparsed.failure.message}`,
      )
    }
    if (!Equal.equals(reparsed.success, value)) {
      throw lawError(
        `canonicalization changed the value\n  input:     ${preview(input)}\n  canonical: ${preview(canonical.success)}\n  before:    ${preview(value)}\n  after:     ${preview(reparsed.success)}`,
      )
    }
    const again = printWith(grammar, reparsed.success, format)
    if (Result.isFailure(again) || !Equal.equals(again.success, canonical.success)) {
      throw lawError(
        `canonicalization is not idempotent\n  once:  ${preview(canonical.success)}\n  twice: ${Result.isFailure(again) ? again.failure.message : preview(again.success)}`,
      )
    }
    return canonical.success
  }

  /** Assert `parse(print(value))` equals `value`. */
  const assertPrintParse = <A>(grammar: Grammar<A>, value: A): void => {
    const printed = printCheckedWith(grammar, value, format)
    if (Result.isFailure(printed)) {
      throw lawError(`parse(print(value)) = value fails: ${printed.failure.message}`)
    }
  }

  /**
   * Assert that `input` parses and that `print(parse(input))` is canonical:
   * parsing the printed form yields an equal value, and printing it again is
   * unchanged. Returns the canonical form.
   */
  const assertParsePrintCanonical = <A>(grammar: Grammar<A>, input: I): I => {
    const parsed = parseWith(grammar, input, format)
    if (Result.isFailure(parsed)) {
      throw lawError(`parse failed for ${preview(input)}: ${parsed.failure.message}`)
    }
    return assertCanonical(grammar, input, parsed.success)
  }

  /** Check `parse(print(value)) = value` over an arbitrary of values. */
  const checkPrintParse = <A>(
    grammar: Grammar<A>,
    arbitrary: FastCheck.Arbitrary<A>,
    params?: FastCheck.Parameters<[A]>,
  ): void => {
    FastCheck.assert(
      FastCheck.property(arbitrary, (value) => {
        assertPrintParse(grammar, value)
      }),
      params,
    )
  }

  /**
   * Check `print(parse(input)) = canonical(input)` over an arbitrary of inputs.
   * Inputs that do not parse are skipped, so a loose generator is fine.
   */
  const checkCanonicalization = <A>(
    grammar: Grammar<A>,
    arbitraryInput: FastCheck.Arbitrary<I>,
    params?: FastCheck.Parameters<[I]>,
  ): void => {
    FastCheck.assert(
      FastCheck.property(arbitraryInput, (input) => {
        const parsed = parseWith(grammar, input, format)
        if (Result.isFailure(parsed)) return FastCheck.pre(false)
        assertCanonical(grammar, input, parsed.success)
      }),
      params,
    )
  }

  return { assertPrintParse, assertParsePrintCanonical, checkPrintParse, checkCanonicalization }
}

export const {
  assertPrintParse,
  assertParsePrintCanonical,
  checkPrintParse,
  checkCanonicalization,
} = lawsFor(textFormat)
