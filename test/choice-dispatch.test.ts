import assert from "node:assert/strict"

import { Result } from "effect"
import { describe, it } from "vitest"

import * as G from "../src/index.ts"
import {
  assertRoundTrip,
  hashed,
  number,
  parseOk,
  plain,
  printOk,
  symbol,
  word,
  wrong,
} from "./helpers.ts"

describe("positional choice picks the first branch whose printer accepts", () => {
  const g = G.choice(plain, hashed)

  it("mis-prints a hashed value as plain", () => {
    assert.equal(printOk(g, wrong), "x")
    assert.deepEqual(parseOk(g, "x"), { kind: "plain", value: "x" })
  })

  it("printChecked rejects output that reads back as another value", () => {
    const r = G.printChecked(g, wrong)
    assert.ok(Result.isFailure(r))
    assert.equal(
      r.failure.message,
      '{"kind":"hashed","value":"x"} prints as "x", which reads back as {"kind":"plain","value":"x"}',
    )
  })

  it("plain print stays unchecked", () => {
    assert.equal(printOk(g, wrong), "x")
  })
})

describe("checkedChoice selects a branch that reads back", () => {
  const g = G.checkedChoice(plain, hashed)

  it("prints with the branch whose text round-trips", () => {
    assert.equal(printOk(g, wrong), "#x")
    assert.equal(printOk(g, { kind: "plain", value: "x" } as const), "x")
  })

  it("explains a value no branch can print faithfully", () => {
    const atom = G.checkedChoice(number, symbol)
    const r = G.print(atom, { kind: "symbol", value: "42" })
    assert.ok(Result.isFailure(r))
    assert.equal(
      r.failure.message,
      [
        'no choice branch accepts {"kind":"symbol","value":"42"}:',
        '  <number>: prints as "42", which reads back as {"kind":"number","value":42}',
        '  <symbol>: prints as "42", which reads back as {"kind":"number","value":42}',
      ].join("\n"),
    )
  })
})

describe("printChecked is the whole-grammar round-trip guarantee", () => {
  it("catches an ambiguous plain choice that no branch selection fixes", () => {
    const atom = G.choice(number, symbol)
    const r = G.printChecked(atom, { kind: "symbol", value: "42" })
    assert.ok(Result.isFailure(r))
    assert.equal(
      r.failure.message,
      '{"kind":"symbol","value":"42"} prints as "42", which reads back as {"kind":"number","value":42}',
    )
  })

  it("succeeds when the round trip holds", () => {
    const atom = G.choice(number, symbol)
    assert.equal(Result.getOrThrow(G.printChecked(atom, { kind: "number", value: 42 })), "42")
  })
})

describe("choiceOn prints by reading the tag", () => {
  const g = G.choiceOn("kind", { plain, hashed })

  it("prints the branch the tag names", () => {
    assert.equal(printOk(g, wrong), "#x")
    assertRoundTrip(g, wrong)
    assertRoundTrip(g, { kind: "plain", value: "x" } as const)
  })

  it("parses in key order", () => {
    assert.deepEqual(parseOk(g, "#abc"), { kind: "hashed", value: "abc" })
    assert.deepEqual(parseOk(g, "abc"), { kind: "plain", value: "abc" })
  })

  it("accepts ordered [key, grammar] entries", () => {
    const entries = G.choiceOn("kind", [
      ["plain", plain],
      ["hashed", hashed],
    ] as const)
    assert.equal(printOk(entries, wrong), "#x")
    assert.deepEqual(parseOk(entries, "#abc"), { kind: "hashed", value: "abc" })
    assert.deepEqual(parseOk(entries, "abc"), { kind: "plain", value: "abc" })
  })

  it("rejects a value without the tag or with an unknown tag", () => {
    // SAFETY: deliberately ill-typed values exercise the runtime checks.
    const missing = G.print(g, { value: "x" } as never)
    assert.ok(Result.isFailure(missing))
    assert.equal(missing.failure.message, 'expected an object with a kind field, got {"value":"x"}')
    // SAFETY: deliberately ill-typed values exercise the runtime checks.
    const unknown = G.print(g, { kind: "other", value: "x" } as never)
    assert.ok(Result.isFailure(unknown))
    assert.equal(
      unknown.failure.message,
      'expected kind to be one of "plain", "hashed", got "other"',
    )
  })

  it("renders with its keys", () => {
    assert.equal(G.render(g), 'on(kind){"plain" => <word> | "hashed" => "#" <word>}')
  })

  it("refuses integer-like object keys", () => {
    // SAFETY: the integer key is rejected at runtime before types matter.
    assert.throws(() => G.choiceOn("kind", { 1: plain } as never), /looks like an integer/)
  })

  it("does not detect an ambiguous grammar on its own", () => {
    const atom = G.choiceOn("kind", { number, symbol })
    // The tag says symbol, so choiceOn prints "42"; the grammar reads it as a number.
    assert.equal(printOk(atom, { kind: "symbol", value: "42" }), "42")
    assert.deepEqual(parseOk(atom, "42"), { kind: "number", value: 42 })
    // printChecked exposes the ambiguity the tag dispatch hides.
    const r = G.printChecked(atom, { kind: "symbol", value: "42" })
    assert.ok(Result.isFailure(r))
  })
})

describe("taggedChoice dispatches on its tag", () => {
  const g = G.taggedChoice("_tag", { word, num: G.integer })

  it("round-trips and renders", () => {
    assertRoundTrip(g, { _tag: "word", value: "abc" })
    assertRoundTrip(g, { _tag: "num", value: 7 })
    assert.equal(G.render(g), 'on(_tag){"word" => <word> | "num" => <integer>}')
  })
})
