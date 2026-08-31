import { Equal, Result } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import type { Grammar } from "./core.ts"
import { preview } from "./errors.ts"
import { parse } from "./parse.ts"
import { print } from "./print.ts"

/**
 * Law helpers for `Grammar`s. The library removes unbound whitespace, so its
 * grammars do not round-trip text exactly. Two laws hold instead:
 *
 * - `parse(print(value)) = value` — printing keeps a value's meaning.
 * - `print(parse(text)) = canonical(text)` — parsing then printing settles on
 *   one canonical form, and printing that form again does not change it.
 */

const lawError = (message: string): Error => new Error(`grammar law: ${message}`)

/** Assert `parse(print(value))` equals `value`. */
export const assertPrintParse = <A>(grammar: Grammar<A>, value: A): void => {
  const printed = print(grammar, value)
  if (Result.isFailure(printed)) {
    throw lawError(`print failed for ${preview(value)}: ${printed.failure.message}`)
  }
  const back = parse(grammar, printed.success)
  if (Result.isFailure(back)) {
    throw lawError(
      `parse(print(value)) did not parse\n  value:   ${preview(value)}\n  printed: ${JSON.stringify(printed.success)}\n  error:   ${back.failure.message}`,
    )
  }
  if (!Equal.equals(back.success, value)) {
    throw lawError(
      `parse(print(value)) changed the value\n  value:    ${preview(value)}\n  printed:  ${JSON.stringify(printed.success)}\n  reparsed: ${preview(back.success)}`,
    )
  }
}

/**
 * Assert that `text` parses and that `print(parse(text))` is canonical: parsing
 * the printed form yields an equal value, and printing it again is unchanged.
 * Returns the canonical text.
 */
export const assertParsePrintCanonical = <A>(grammar: Grammar<A>, text: string): string => {
  const parsed = parse(grammar, text)
  if (Result.isFailure(parsed)) {
    throw lawError(`parse failed for ${JSON.stringify(text)}: ${parsed.failure.message}`)
  }
  const canonical = print(grammar, parsed.success)
  if (Result.isFailure(canonical)) {
    throw lawError(
      `print(parse(text)) failed\n  text:   ${JSON.stringify(text)}\n  parsed: ${preview(parsed.success)}\n  error:  ${canonical.failure.message}`,
    )
  }
  const reparsed = parse(grammar, canonical.success)
  if (Result.isFailure(reparsed)) {
    throw lawError(
      `the canonical text does not parse\n  text:      ${JSON.stringify(text)}\n  canonical: ${JSON.stringify(canonical.success)}\n  error:     ${reparsed.failure.message}`,
    )
  }
  if (!Equal.equals(reparsed.success, parsed.success)) {
    throw lawError(
      `canonicalization changed the value\n  text:      ${JSON.stringify(text)}\n  canonical: ${JSON.stringify(canonical.success)}\n  before:    ${preview(parsed.success)}\n  after:     ${preview(reparsed.success)}`,
    )
  }
  const again = print(grammar, reparsed.success)
  if (Result.isFailure(again) || again.success !== canonical.success) {
    throw lawError(
      `canonicalization is not idempotent\n  once:  ${JSON.stringify(canonical.success)}\n  twice: ${Result.isFailure(again) ? again.failure.message : JSON.stringify(again.success)}`,
    )
  }
  return canonical.success
}

/** Check `parse(print(value)) = value` over an arbitrary of values. */
export const checkPrintParse = <A>(
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
 * Check `print(parse(text)) = canonical(text)` over an arbitrary of text.
 * Inputs that do not parse are skipped, so a loose generator is fine.
 */
export const checkCanonicalization = <A>(
  grammar: Grammar<A>,
  arbitraryText: FastCheck.Arbitrary<string>,
  params?: FastCheck.Parameters<[string]>,
): void => {
  FastCheck.assert(
    FastCheck.property(arbitraryText, (text) => {
      FastCheck.pre(Result.isSuccess(parse(grammar, text)))
      assertParsePrintCanonical(grammar, text)
    }),
    params,
  )
}
