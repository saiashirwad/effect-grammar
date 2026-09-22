import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"
import { assertRoundTrip, hashed, number, parseOk, plain, printOk, symbol, word, wrong } from "./helpers.ts"

describe("first choice policy picks the first branch whose printer accepts", () => {
  const g = G.choice([plain, hashed])

  it.effect("mis-prints a hashed value as plain", () =>
    Effect.sync(() => {
      assert.equal(Result.getOrThrow(G.printUnchecked(g, wrong)), "x")
      assert.deepEqual(parseOk(g, "x"), { kind: "plain", value: "x" })
    }),
  )

  it.effect("print rejects output that reads back as another value", () =>
    Effect.sync(() => {
      const r = G.print(g, wrong)
      assert.ok(Result.isFailure(r))
      assert.equal(
        r.failure.message,
        '{"kind":"hashed","value":"x"} prints as "x", which reads back as {"kind":"plain","value":"x"}',
      )
    }),
  )

  it.effect("printUnchecked skips the whole-output check", () =>
    Effect.sync(() => {
      assert.equal(Result.getOrThrow(G.printUnchecked(g, wrong)), "x")
    }),
  )

  it.effect("has the same default, empty-options, and explicit first policies", () =>
    Effect.sync(() => {
      for (const options of [undefined, {}, { print: "first" }] as const) {
        const grammar = G.choice([plain, hashed], options)
        assert.deepEqual(parseOk(grammar, "#x"), wrong)
        assert.equal(Result.getOrThrow(G.printUnchecked(grammar, wrong)), "x")
        const result = G.print(grammar, wrong)
        assert.ok(Result.isFailure(result))
        assert.equal(result.failure.issue._tag, "RoundTrip")
      }
    }),
  )
})

describe("roundTrip choice policy selects a branch that reads back", () => {
  const g = G.choice([plain, hashed], { print: "roundTrip" })

  it.effect("prints with the branch whose text round-trips", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "#x")
      assert.equal(Result.getOrThrow(G.printUnchecked(g, wrong)), "#x")
      assert.equal(printOk(g, { kind: "plain", value: "x" } as const), "x")
    }),
  )

  it.effect("explains a value no branch can print faithfully", () =>
    Effect.sync(() => {
      const atom = G.choice([number, symbol], { print: "roundTrip" })
      const r = G.print(atom, { kind: "symbol", value: "42" })
      assert.ok(Result.isFailure(r))
      assert.equal(
        r.failure.message,
        [
          'no choice branch accepts {"kind":"symbol","value":"42"}:',
          '  transform: prints as "42", which reads back as {"kind":"number","value":42}',
          '  transform: prints as "42", which reads back as {"kind":"number","value":42}',
        ].join("\n"),
      )
    }),
  )

  it.effect("uses parent refs for local candidate checks inside wrappers", () =>
    Effect.sync(() => {
      const grammar = G.gen(function* () {
        const size = yield* G.integer.pipe(G.suffix(":"))
        const payload = G.take(size).pipe(G.filter((value: string) => /^[a-z]+$/.test(value), "word"))
        const plain = payload.pipe(
          G.transform({
            decode: (value) => ({ kind: "plain" as const, value }),
            encode: (value) => value.value,
          }),
        )
        const hashed = payload.pipe(
          G.prefix("#"),
          G.transform({
            decode: (value) => ({ kind: "hashed" as const, value }),
            encode: (value) => value.value,
          }),
        )
        const body = yield* G.choice([plain, hashed], { print: "roundTrip" }).pipe(G.between("[", "]"))
        return { size, body }
      })
      const value = { size: 1, body: wrong }
      assert.deepEqual(G.diagnose(grammar), [])
      assert.equal(Result.getOrThrow(G.printUnchecked(grammar, value)), "1:[#x]")
      assert.equal(printOk(grammar, value), "1:[#x]")
    }),
  )
})

describe("print is the whole-grammar round-trip guarantee", () => {
  it.effect("rejects output that cannot parse even when a nested roundTrip choice succeeds", () =>
    Effect.sync(() => {
      const grammar = G.tuple(G.choice([G.integer], { print: "roundTrip" }), G.integer)
      assert.equal(Result.getOrThrow(G.printUnchecked(grammar, [1, 2])), "12")
      const result = G.print(grammar, [1, 2])
      assert.ok(Result.isFailure(result))
      assert.equal(result.failure.issue._tag, "RoundTrip")
      assert.match(result.failure.message, /does not parse back/)
    }),
  )

  it.effect("catches an ambiguous plain choice that no branch selection fixes", () =>
    Effect.sync(() => {
      const atom = G.choice([number, symbol])
      const r = G.print(atom, { kind: "symbol", value: "42" })
      assert.ok(Result.isFailure(r))
      assert.equal(
        r.failure.message,
        '{"kind":"symbol","value":"42"} prints as "42", which reads back as {"kind":"number","value":42}',
      )
    }),
  )

  it.effect("succeeds when the round trip holds", () =>
    Effect.sync(() => {
      const atom = G.choice([number, symbol])
      assert.equal(Result.getOrThrow(G.print(atom, { kind: "number", value: 42 })), "42")
    }),
  )
})

describe("dispatch prints by reading the tag", () => {
  const g = G.dispatch("kind", [
    ["plain", plain],
    ["hashed", hashed],
  ] as const)

  it.effect("prints the branch the tag names", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, wrong), "#x")
      assertRoundTrip(g, wrong)
      assertRoundTrip(g, { kind: "plain", value: "x" } as const)
    }),
  )

  it.effect("parses in entry order", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, "#abc"), { kind: "hashed", value: "abc" })
      assert.deepEqual(parseOk(g, "abc"), { kind: "plain", value: "abc" })
    }),
  )

  it.effect("tries entries in the listed order", () =>
    Effect.sync(() => {
      const reversed = G.dispatch("kind", [
        ["hashed", hashed],
        ["plain", plain],
      ] as const)
      assert.equal(printOk(reversed, wrong), "#x")
      assert.deepEqual(parseOk(reversed, "#abc"), { kind: "hashed", value: "abc" })
      assert.deepEqual(parseOk(reversed, "abc"), { kind: "plain", value: "abc" })
    }),
  )

  it.effect("rejects a value without the tag or with an unknown tag", () =>
    Effect.sync(() => {
      // SAFETY: deliberately ill-typed values exercise the runtime checks.
      const missing = G.print(g, { value: "x" } as never)
      assert.ok(Result.isFailure(missing))
      assert.equal(missing.failure.message, 'expected an object with a kind field, got {"value":"x"}')
      // SAFETY: deliberately ill-typed values exercise the runtime checks.
      const unknown = G.print(g, { kind: "other", value: "x" } as never)
      assert.ok(Result.isFailure(unknown))
      assert.equal(unknown.failure.message, 'expected kind to be one of "plain", "hashed", got "other"')
    }),
  )

  it.effect("renders with its keys", () =>
    Effect.sync(() => {
      assert.equal(G.render(g), 'on(kind){"plain" => <word> | "hashed" => "#" <word>}')
    }),
  )

  it.effect("accepts integer and numeric-looking keys", () =>
    Effect.sync(() => {
      const one = G.literal("x").pipe(G.as({ kind: 1 as const, value: "x" as const }))
      const numeric = G.literal("y").pipe(G.as({ kind: "01" as const, value: "y" as const }))
      const negative = G.literal("z").pipe(G.as({ kind: "-1" as const, value: "z" as const }))
      const keyed = G.dispatch("kind", [
        [1, one],
        ["01", numeric],
        ["-1", negative],
      ] as const)
      assertRoundTrip(keyed, { kind: 1, value: "x" })
      assertRoundTrip(keyed, { kind: "01", value: "y" })
      assertRoundTrip(keyed, { kind: "-1", value: "z" })
      assert.throws(
        () =>
          G.dispatch("kind", [
            [1, one],
            [1, one],
          ] as const),
        /dispatch: duplicate key 1/,
      )
    }),
  )

  it.effect("does not detect an ambiguous grammar on its own", () =>
    Effect.sync(() => {
      const atom = G.dispatch("kind", [
        ["number", number],
        ["symbol", symbol],
      ] as const)
      assert.equal(Result.getOrThrow(G.printUnchecked(atom, { kind: "symbol", value: "42" })), "42")
      assert.deepEqual(parseOk(atom, "42"), { kind: "number", value: 42 })
      const r = G.print(atom, { kind: "symbol", value: "42" })
      assert.ok(Result.isFailure(r))
    }),
  )
})

describe("taggedChoice dispatches on its tag", () => {
  const g = G.taggedChoice("_tag", [
    ["word", word],
    ["num", G.integer],
  ] as const)

  it.effect("round-trips and renders", () =>
    Effect.sync(() => {
      assertRoundTrip(g, { _tag: "word", value: "abc" })
      assertRoundTrip(g, { _tag: "num", value: 7 })
      assert.equal(G.render(g), 'on(_tag){"word" => <word> | "num" => <integer>}')
    }),
  )

  it.effect("rejects duplicate keys, the reserved tag, and malformed print values", () =>
    Effect.sync(() => {
      assert.throws(() => G.taggedChoice("_tag", []), /dispatch: at least one case is required/)
      assert.throws(
        () =>
          G.taggedChoice("_tag", [
            [1, G.integer],
            [1, word],
          ] as const),
        /dispatch: duplicate key 1/,
      )
      // SAFETY: the reserved tag name is rejected at runtime before types matter.
      assert.throws(() => G.taggedChoice("value" as never, [["a", word]] as const), /reserved/)
      // SAFETY: malformed value deliberately exercises runtime validation.
      const malformed = G.print(g, { _tag: "word" } as never)
      assert.ok(Result.isFailure(malformed))
      assert.match(malformed.failure.message, /value field/)
    }),
  )
})
