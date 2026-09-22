import assert from "node:assert/strict"

import { Result } from "effect"

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

export { assertPrintParse as assertRoundTrip } from "../src/testing.ts"

// Both encoders ignore the discriminant, so a trial-based printer can choose
// `plain` for a `hashed` value and print "x" instead of "#x".
export const word = Grammar.regex(/[a-z]+/, "word")
export const plain = word.pipe(
  Grammar.transform({
    decode: (value) => ({ kind: "plain" as const, value }),
    encode: (v) => v.value,
  }),
)
export const hashed = word.pipe(
  Grammar.prefix("#"),
  Grammar.transform({
    decode: (value) => ({ kind: "hashed" as const, value }),
    encode: (v) => v.value,
  }),
)
export const wrong = { kind: "hashed", value: "x" } as const

// Both branches accept "42", so the symbol parses back as a number
// regardless of which branch prints it.
export const number = Grammar.regex(/\d+/, "number").pipe(
  Grammar.transform({
    decode: (raw) => ({ kind: "number" as const, value: Number(raw) }),
    encode: (n) => String(n.value),
  }),
)
export const symbol = Grammar.regex(/[^\s()]+/, "symbol").pipe(
  Grammar.transform({
    decode: (value) => ({ kind: "symbol" as const, value }),
    encode: (s) => s.value,
  }),
)
