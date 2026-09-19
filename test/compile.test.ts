import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"

const word = G.regex(/[a-z]+/, "word")

// A ref captured inside a gen and used after it closes.
const escaped = (() => {
  let leaked: G.Grammar<string> | undefined
  G.gen(function* () {
    const length = yield* G.integer
    leaked = G.take(length)
    return length
  })
  return leaked!
})()

describe("validate", () => {
  it.effect("passes a sound grammar", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const length = yield* G.integer
        yield* G.literal(":")
        const payload = yield* G.take(length)
        return { length, payload }
      })
      assert.deepEqual(G.validate(g), [])
    }),
  )

  it.effect("catches a ref used outside the gen that bound it", () =>
    Effect.sync(() => {
      const issues = G.validate(escaped)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
    }),
  )

  it.effect("catches unbounded repetition of an empty-matching grammar", () =>
    Effect.sync(() => {
      const issues = G.validate(G.many(G.regex(/x*/, "xs")))
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /can match the empty string/)
      assert.throws(() => G.prepare(G.many(G.literal(""))), /can match the empty string/)
    }),
  )

  it.effect("rejects bounded repetition of an empty item too", () =>
    Effect.sync(() => {
      const grammar = G.many(G.empty, { min: 1, max: 2 })

      assert.match(G.validate(grammar)[0]!.message, /zero-width elements/)
      assert.throws(() => G.prepare(grammar), /zero-width elements/)
    }),
  )

  it.effect("detects that a zero-maximum repetition always matches empty", () =>
    Effect.sync(() => {
      const inner = G.many(G.empty, { max: 0 })
      const outer = G.many(inner)

      const issues = G.validate(outer)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /can match the empty string/)
      assert.throws(() => G.prepare(outer), /can match the empty string/)
    }),
  )

  it.effect("does not claim a fallible transform matches empty", () =>
    Effect.sync(() => {
      const nonempty = G.regex(/x*/, "xs").pipe(
        G.transformOrFail({
          decode: (value) =>
            value === ""
              ? Result.fail({ message: "expected at least one x" })
              : Result.succeed(value),
          encode: Result.succeed,
        }),
      )
      const grammar = G.many(nonempty.pipe(G.label("nonempty xs")))

      assert.deepEqual(G.validate(grammar), [])
      assert.deepEqual(Result.getOrThrow(G.prepare(grammar).parse("xx")), ["xx"])
    }),
  )

  it.effect("leaves an empty-producing transform to the runtime progress check", () =>
    Effect.sync(() => {
      const empty = G.regex(/x*/, "xs").pipe(
        G.transform({
          decode: () => "x",
          encode: () => "",
        }),
        G.skip(""),
      )
      const grammar = G.many(empty)

      assert.deepEqual(G.validate(grammar), [])
      const parsed = G.prepare(grammar).parse("")
      assert.equal(Result.isFailure(parsed), true)
      if (Result.isFailure(parsed)) assert.match(parsed.failure.message, /consumes input/)
    }),
  )

  it.effect("validates a delayed grammar in each ref scope where it is used", () =>
    Effect.sync(() => {
      let delayed: G.Grammar<string> | undefined
      const owner = G.gen(function* () {
        const length = yield* G.integer
        const dependent = G.gen(function* () {
          const payload = yield* G.take(length)
          return payload
        })
        delayed = G.suspend(() => dependent)
        const payload = yield* delayed
        return { length, payload }
      })

      const grammar = G.choice(owner, delayed!)
      const issues = G.validate(grammar)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
      assert.throws(() => G.prepare(grammar), /the grammar has 1 issue/)
    }),
  )

  it.effect("reports one issue when a delayed grammar repeats in one ref scope", () =>
    Effect.sync(() => {
      let delayed: G.Grammar<string> | undefined
      G.gen(function* () {
        const length = yield* G.integer
        const dependent = G.gen(function* () {
          const payload = yield* G.take(length)
          return payload
        })
        delayed = G.suspend(() => dependent)
        return length
      })

      assert.equal(G.validate(G.choice(delayed!, delayed!)).length, 1)
    }),
  )

  it.effect(
    "has nothing to report for duplicate match keys, which matchValue rejects on construction",
    () =>
      Effect.sync(() => {
        const selector = G.choice(G.literal("a").pipe(G.as(1)), G.literal("b").pipe(G.as(2)))
        assert.throws(
          () =>
            G.gen(function* () {
              const kind = yield* selector
              const value = yield* G.matchValue(kind, [
                [1, G.integer],
                [1, G.integer],
                [2, G.integer],
              ] as const)
              return { kind, value }
            }),
          /matchValue: duplicate key 1/,
        )
      }),
  )
})

describe("prepare", () => {
  it.effect("returns prepared operations for a sound grammar", () =>
    Effect.sync(() => {
      const g = G.struct({ host: word, port: G.integer.pipe(G.prefix(":")) })
      const prepared = G.prepare(g)
      assert.deepEqual(Result.getOrThrow(prepared.parse("h:80")), { host: "h", port: 80 })
      assert.equal(Result.getOrThrow(prepared.print({ host: "h", port: 80 })), "h:80")
      assert.equal(Result.getOrThrow(prepared.printChecked({ host: "h", port: 80 })), "h:80")
      assert.equal(prepared.render, 'host:<word> port:(":" <integer>)')
    }),
  )

  it.effect("throws on an invalid grammar", () =>
    Effect.sync(() => {
      assert.throws(() => G.prepare(escaped), /the grammar has 1 issue/)
    }),
  )
})

describe("auditFidelity", () => {
  it.effect("is empty for grammars built from isos", () =>
    Effect.sync(() => {
      assert.deepEqual(G.auditFidelity(G.integer), [])
    }),
  )

  it.effect("lists transforms that claim no inverse law", () =>
    Effect.sync(() => {
      const g = G.regex(/\d+/, "d").pipe(
        G.transform({ decode: Number, encode: String, name: "num" }),
      )
      assert.deepEqual(G.auditFidelity(g), [{ name: "num", fidelity: "unchecked" }])
    }),
  )

  it.effect("reports partialIso as partial", () =>
    Effect.sync(() => {
      const g = G.regex(/\d+/, "d").pipe(
        G.partialIso({
          decode: (raw) => Result.succeed(Number(raw)),
          encode: (n) => Result.succeed(String(n)),
          name: "p",
        }),
      )
      assert.deepEqual(G.auditFidelity(g), [{ name: "p", fidelity: "partial" }])
    }),
  )
})
