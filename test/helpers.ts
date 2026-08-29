import assert from "node:assert/strict"

import { Equal, Result } from "effect"

import * as Grammar from "../src/index.ts"

export const parseOk = <A>(grammar: Grammar.Grammar<A>, input: string): A => {
  const r = Grammar.parse(grammar, input)
  if (Result.isFailure(r)) assert.fail(`expected parse success, got ${r.failure.message}`)
  return r.success
}

export const parseFail = <A>(grammar: Grammar.Grammar<A>, input: string): Grammar.ParseError => {
  const r = Grammar.parse(grammar, input)
  if (Result.isSuccess(r)) {
    assert.fail(`expected parse failure, got ${JSON.stringify(r.success)}`)
  }
  return r.failure
}

export const printOk = <A>(grammar: Grammar.Grammar<A>, value: A): string => {
  const r = Grammar.print(grammar, value)
  if (Result.isFailure(r)) assert.fail(`expected print success, got ${r.failure.message}`)
  return r.success
}

export const printFail = <A>(grammar: Grammar.Grammar<A>, value: A): Grammar.PrintError => {
  const r = Grammar.print(grammar, value)
  if (Result.isSuccess(r)) {
    assert.fail(`expected print failure, got ${JSON.stringify(r.success)}`)
  }
  return r.failure
}

export const assertRoundTrip = <A>(grammar: Grammar.Grammar<A>, value: A) => {
  const printed = printOk(grammar, value)
  const reparsed = parseOk(grammar, printed)
  if (!Equal.equals(reparsed, value)) {
    assert.fail(
      `round trip changed the value\n  original: ${JSON.stringify(value)}\n  printed:  ${JSON.stringify(printed)}\n  reparsed: ${JSON.stringify(reparsed)}`,
    )
  }
}
