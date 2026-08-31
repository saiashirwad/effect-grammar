import { Equal, Result } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import type { Grammar } from "./core.ts"
import { preview } from "./errors.ts"
import { parse } from "./parse.ts"
import { print, printChecked } from "./print.ts"

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
  const printed = printChecked(grammar, value)
  if (Result.isFailure(printed)) {
    throw lawError(`parse(print(value)) = value fails: ${printed.failure.message}`)
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
  return assertCanonical(grammar, text, parsed.success)
}

const assertCanonical = <A>(grammar: Grammar<A>, text: string, value: A): string => {
  const canonical = print(grammar, value)
  if (Result.isFailure(canonical)) {
    throw lawError(
      `print(parse(text)) failed\n  text:   ${JSON.stringify(text)}\n  parsed: ${preview(value)}\n  error:  ${canonical.failure.message}`,
    )
  }
  const reparsed = parse(grammar, canonical.success)
  if (Result.isFailure(reparsed)) {
    throw lawError(
      `the canonical text does not parse\n  text:      ${JSON.stringify(text)}\n  canonical: ${JSON.stringify(canonical.success)}\n  error:     ${reparsed.failure.message}`,
    )
  }
  if (!Equal.equals(reparsed.success, value)) {
    throw lawError(
      `canonicalization changed the value\n  text:      ${JSON.stringify(text)}\n  canonical: ${JSON.stringify(canonical.success)}\n  before:    ${preview(value)}\n  after:     ${preview(reparsed.success)}`,
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
      const parsed = parse(grammar, text)
      if (Result.isFailure(parsed)) return FastCheck.pre(false)
      assertCanonical(grammar, text, parsed.success)
    }),
    params,
  )
}
