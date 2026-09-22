import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"

const word = G.regex(/[a-z]+/, "word")

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
      const issues = G.validate(G.regex(/x*/, "xs").pipe(G.many()))
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /can match the empty string/)
      assert.match(G.validate(G.literal("").pipe(G.many()))[0]!.message, /can match the empty string/)
    }),
  )

  it.effect("rejects bounded repetition of an empty item too", () =>
    Effect.sync(() => {
      const grammar = G.empty.pipe(G.many({ min: 1, max: 2 }))

      const issues = G.validate(grammar)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /zero-width elements/)
    }),
  )

  it.effect("checks the item of a repeat unless its constant count is zero", () =>
    Effect.sync(() => {
      const item = G.optional(G.literal("a"))
      assert.match(G.validate(item.pipe(G.repeat(2)))[0]!.message, /zero-width elements/)
      assert.match(G.validate(item.pipe(G.countPrefixed(G.integer)))[0]!.message, /zero-width elements/)
      assert.deepEqual(G.validate(item.pipe(G.repeat(0))), [])
    }),
  )

  it.effect("sees through a transform that cannot match empty, and through a constant", () =>
    Effect.sync(() => {
      assert.match(G.validate(G.integer.pipe(G.many(), G.many()))[0]!.message, /zero-width elements/)
      assert.match(G.validate(G.literals("", "a").pipe(G.many()))[0]!.message, /zero-width elements/)
      assert.match(G.validate(G.flag("-").pipe(G.many()))[0]!.message, /zero-width elements/)
      assert.deepEqual(G.validate(G.literals("a", "b").pipe(G.many())), [])
    }),
  )

  it.effect("detects that a zero-maximum repetition always matches empty", () =>
    Effect.sync(() => {
      const inner = G.empty.pipe(G.many({ max: 0 }))
      const outer = inner.pipe(G.many())

      const issues = G.validate(outer)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /can match the empty string/)
    }),
  )

  it.effect("does not claim a fallible transform matches empty", () =>
    Effect.sync(() => {
      const nonempty = G.regex(/x*/, "xs").pipe(
        G.transformOrFail({
          decode: (value) => (value === "" ? Result.fail("at least one x") : Result.succeed(value)),
          encode: Result.succeed,
        }),
      )
      const grammar = nonempty.pipe(G.label("nonempty xs"), G.many())

      assert.deepEqual(G.validate(grammar), [])
      assert.deepEqual(Result.getOrThrow(G.parse(grammar, "xx")), ["xx"])
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
      const grammar = empty.pipe(G.many())

      assert.deepEqual(G.validate(grammar), [])
      const parsed = G.parse(grammar, "")
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

  it.effect("has nothing to report for duplicate match keys, which match rejects on construction", () =>
    Effect.sync(() => {
      const selector = G.choice(G.literal("a").pipe(G.as(1)), G.literal("b").pipe(G.as(2)))
      assert.throws(
        () =>
          G.gen(function* () {
            const kind = yield* selector
            const value = yield* G.match(kind, [
              [1, G.integer],
              [1, G.integer],
              [2, G.integer],
            ] as const)
            return { kind, value }
          }),
        /match: duplicate key 1/,
      )
    }),
  )

  it.effect("reports a step that is parsed but not returned", () =>
    Effect.sync(() => {
      const grammar = G.gen(function* () {
        yield* word
        yield* G.literal(":")
        const port = yield* G.integer
        return { port }
      })

      const issues = G.validate(grammar)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /gen: step 1 \(word\) is parsed but not returned/)
    }),
  )
})

describe("direct operations", () => {
  it.effect("parse, print, printUnchecked, and render a sound grammar", () =>
    Effect.sync(() => {
      const g = G.struct({ host: word, port: G.integer.pipe(G.prefix(":")) })
      assert.deepEqual(G.validate(g), [])
      assert.deepEqual(Result.getOrThrow(G.parse(g, "h:80")), { host: "h", port: 80 })
      assert.equal(Result.getOrThrow(G.print(g, { host: "h", port: 80 })), "h:80")
      assert.equal(Result.getOrThrow(G.printUnchecked(g, { host: "h", port: 80 })), "h:80")
      assert.equal(G.render(g), 'host:<word> port:(":" <integer>)')
    }),
  )

  it.effect("reports the issues of an invalid grammar", () =>
    Effect.sync(() => {
      const issues = G.validate(escaped)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
    }),
  )
})
