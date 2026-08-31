import assert from "node:assert/strict"

import { Result } from "effect"
import { describe, it } from "vitest"

import * as G from "../src/index.ts"
import { assertRoundTrip, parseOk, printOk } from "./helpers.ts"

// Two branches whose encoders ignore the discriminant. `plain` accepts any
// value with a `value` field, so a trial-based printer picks it for a `hashed`
// value and prints "x" instead of "#x".
const word = G.regex(/[a-z]+/, "word")
const plain = word.pipe(
  G.transform({
    decode: (value) => ({ kind: "plain" as const, value }),
    encode: (v) => v.value,
  }),
)
const hashed = G.prefix("#", word).pipe(
  G.transform({
    decode: (value) => ({ kind: "hashed" as const, value }),
    encode: (v) => v.value,
  }),
)
const wrong = { kind: "hashed", value: "x" } as const

describe("positional choice picks the first branch whose printer accepts", () => {
  const g = G.choice(plain, hashed)

  it("mis-prints a hashed value as plain", () => {
    assert.equal(printOk(g, wrong), "x")
    assert.deepEqual(parseOk(g, "x"), { kind: "plain", value: "x" })
  })

  it("verify: true rejects the branch that does not read back", () => {
    const r = G.print(g, wrong, { verify: true })
    assert.ok(Result.isSuccess(r))
    assert.equal(r.success, "#x")
  })

  it("verify: true explains a value no branch can print faithfully", () => {
    const g2 = G.choice(hashed, plain)
    // "#x" reads back as hashed, and "x" reads back as plain, so both agree
    // with their own value; only a genuinely ambiguous grammar fails.
    assert.equal(
      Result.getOrThrow(G.print(g2, { kind: "plain", value: "x" } as const, { verify: true })),
      "x",
    )

    const number = G.regex(/\d+/, "number").pipe(
      G.transform({
        decode: (raw) => ({ kind: "number" as const, value: Number(raw) }),
        encode: (n) => String(n.value),
      }),
    )
    const symbol = G.regex(/[^\s()]+/, "symbol").pipe(
      G.transform({
        decode: (value) => ({ kind: "symbol" as const, value }),
        encode: (s) => s.value,
      }),
    )
    const atom = G.choice(number, symbol)
    const r = G.print(atom, { kind: "symbol", value: "42" }, { verify: true })
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

  it("refuses integer-like keys", () => {
    // SAFETY: the integer key is rejected at runtime before types matter.
    assert.throws(() => G.choiceOn("kind", { 1: plain } as never), /looks like an integer/)
  })

  it("does not detect an ambiguous grammar on its own", () => {
    const number = G.regex(/\d+/, "number").pipe(
      G.transform({
        decode: (raw) => ({ kind: "number" as const, value: Number(raw) }),
        encode: (n) => String(n.value),
      }),
    )
    const symbol = G.regex(/[^\s()]+/, "symbol").pipe(
      G.transform({
        decode: (value) => ({ kind: "symbol" as const, value }),
        encode: (s) => s.value,
      }),
    )
    const atom = G.choiceOn("kind", { number, symbol })
    // The tag says symbol, so choiceOn prints "42"; the grammar reads it as a number.
    assert.equal(printOk(atom, { kind: "symbol", value: "42" }), "42")
    assert.deepEqual(parseOk(atom, "42"), { kind: "number", value: 42 })
    // verify has nothing to check here: the dispatch is not a trial.
    assert.equal(
      Result.getOrThrow(G.print(atom, { kind: "symbol", value: "42" }, { verify: true })),
      "42",
    )
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
