import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

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

  it.effect("mis-prints a hashed value as plain", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "x")
      assert.deepEqual(parseOk(g, "x"), { kind: "plain", value: "x" })
    }),
  )

  it.effect("printChecked rejects output that reads back as another value", () =>
    Effect.sync(() => {
      const r = G.printChecked(g, wrong)
      assert.ok(Result.isFailure(r))
      assert.equal(
        r.failure.message,
        '{"kind":"hashed","value":"x"} prints as "x", which reads back as {"kind":"plain","value":"x"}',
      )
    }),
  )

  it.effect("plain print stays unchecked", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "x")
    }),
  )
})

describe("checkedChoice selects a branch that reads back", () => {
  const g = G.checkedChoice(plain, hashed)

  it.effect("prints with the branch whose text round-trips", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "#x")
      assert.equal(printOk(g, { kind: "plain", value: "x" } as const), "x")
    }),
  )

  it.effect("explains a value no branch can print faithfully", () =>
    Effect.sync(() => {
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
    }),
  )
})

describe("printChecked is the whole-grammar round-trip guarantee", () => {
  it.effect("catches an ambiguous plain choice that no branch selection fixes", () =>
    Effect.sync(() => {
      const atom = G.choice(number, symbol)
      const r = G.printChecked(atom, { kind: "symbol", value: "42" })
      assert.ok(Result.isFailure(r))
      assert.equal(
        r.failure.message,
        '{"kind":"symbol","value":"42"} prints as "42", which reads back as {"kind":"number","value":42}',
      )
    }),
  )

  it.effect("succeeds when the round trip holds", () =>
    Effect.sync(() => {
      const atom = G.choice(number, symbol)
      assert.equal(Result.getOrThrow(G.printChecked(atom, { kind: "number", value: 42 })), "42")
    }),
  )
})

describe("choiceOn prints by reading the tag", () => {
  const g = G.choiceOn("kind", { plain, hashed })

  it.effect("prints the branch the tag names", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "#x")
      assertRoundTrip(g, wrong)
      assertRoundTrip(g, { kind: "plain", value: "x" } as const)
    }),
  )

  it.effect("parses in key order", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, "#abc"), { kind: "hashed", value: "abc" })
      assert.deepEqual(parseOk(g, "abc"), { kind: "plain", value: "abc" })
    }),
  )

  it.effect("accepts ordered [key, grammar] entries", () =>
    Effect.sync(() => {
      const entries = G.choiceOnEntries("kind", [
        ["plain", plain],
        ["hashed", hashed],
      ] as const)
      assert.equal(printOk(entries, wrong), "#x")
      assert.deepEqual(parseOk(entries, "#abc"), { kind: "hashed", value: "abc" })
      assert.deepEqual(parseOk(entries, "abc"), { kind: "plain", value: "abc" })
    }),
  )

  it.effect("rejects a value without the tag or with an unknown tag", () =>
    Effect.sync(() => {
      // SAFETY: deliberately ill-typed values exercise the runtime checks.
      const missing = G.print(g, { value: "x" } as never)
      assert.ok(Result.isFailure(missing))
      assert.equal(
        missing.failure.message,
        'expected an object with a kind field, got {"value":"x"}',
      )
      // SAFETY: deliberately ill-typed values exercise the runtime checks.
      const unknown = G.print(g, { kind: "other", value: "x" } as never)
      assert.ok(Result.isFailure(unknown))
      assert.equal(
        unknown.failure.message,
        'expected kind to be one of "plain", "hashed", got "other"',
      )
    }),
  )

  it.effect("renders with its keys", () =>
    Effect.sync(() => {
      assert.equal(G.render(g), 'on(kind){"plain" => <word> | "hashed" => "#" <word>}')
    }),
  )

  it.effect("refuses array-index object keys without rejecting other numeric-looking keys", () =>
    Effect.sync(() => {
      // SAFETY: the array-index key is rejected at runtime before types matter.
      assert.throws(() => G.choiceOn("kind", { 1: plain } as never), /looks like an integer/)
      const numeric = G.literal("x").pipe(G.as({ kind: "01" as const, value: "x" as const }))
      assert.doesNotThrow(() => G.choiceOn("kind", { "01": numeric }))
      const negative = G.literal("x").pipe(G.as({ kind: "-1" as const, value: "x" as const }))
      assert.doesNotThrow(() => G.choiceOn("kind", { "-1": negative }))
    }),
  )

  it.effect("does not detect an ambiguous grammar on its own", () =>
    Effect.sync(() => {
      const atom = G.choiceOn("kind", { number, symbol })
      assert.equal(printOk(atom, { kind: "symbol", value: "42" }), "42")
      assert.deepEqual(parseOk(atom, "42"), { kind: "number", value: 42 })
      // Tag dispatch still needs a whole-grammar round-trip check.
      const r = G.printChecked(atom, { kind: "symbol", value: "42" })
      assert.ok(Result.isFailure(r))
    }),
  )
})

describe("taggedChoice dispatches on its tag", () => {
  const g = G.taggedChoice("_tag", { word, num: G.integer })

  it.effect("round-trips and renders", () =>
    Effect.sync(() => {
      assertRoundTrip(g, { _tag: "word", value: "abc" })
      assertRoundTrip(g, { _tag: "num", value: 7 })
      assert.equal(G.render(g), 'on(_tag){"word" => <word> | "num" => <integer>}')
    }),
  )

  it.effect("rejects reordered keys and malformed print values", () =>
    Effect.sync(() => {
      // SAFETY: integer key deliberately exercises runtime validation.
      assert.throws(() => G.taggedChoice("_tag", { 1: G.integer } as never), /array index/)
      // SAFETY: malformed value deliberately exercises runtime validation.
      const malformed = G.print(g, { _tag: "word" } as never)
      assert.ok(Result.isFailure(malformed))
      assert.match(malformed.failure.message, /value field/)
    }),
  )
})
