import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import * as Grammar from "../src/index.ts"
import { parseFail, parseOk, printFail, printOk } from "./helpers.ts"

describe("correctness regressions", () => {
  it.effect("rejects invalid repetition bounds at construction", () =>
    Effect.sync(() => {
      for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => Grammar.literal("x").pipe(Grammar.many({ min: n })), RangeError)
        assert.throws(() => Grammar.literal("x").pipe(Grammar.sepBy(",", { min: n })), RangeError)
      }
    }))

  it.effect("a failing choice option does not leave the cursor moved", () =>
    Effect.sync(() => {
      const g = Grammar.gen(function*() {
        const head = yield* Grammar.choice([
          Grammar.literal("abc").pipe(Grammar.as(1)),
          Grammar.literal("ab").pipe(Grammar.as(2)),
        ])
        yield* Grammar.literal("!")
        return { head }
      })
      assert.deepEqual(parseOk(g, "ab!"), { head: 2 })
    }))

  it.effect("a transform guard that rejects rewinds so the next option can try", () =>
    Effect.sync(() => {
      const small = Grammar.integer.pipe(
        Grammar.transform({
          decode: (n) => n,
          encode: (n) => n,
        }),
        Grammar.filter((u: number) => Number.isSafeInteger(u) && u < 10, "small"),
      )
      const g = Grammar.choice([small, Grammar.regex(/\d+/, "digits")])
      assert.equal(parseOk(g, "123"), "123")
      assert.equal(parseOk(g, "3"), 3)
    }))

  it.effect("strict end-of-input reports alongside the deeper expectation", () =>
    Effect.sync(() => {
      const e = parseFail(Grammar.integer.pipe(Grammar.sepBy(",")), "1,2 ")
      assert.equal(e.pos, 3)
      assert.deepEqual(e.expected, ["\",\"", "end of input"])
    }))

  it.effect("gen does not force a suspend thunk at construction", () =>
    Effect.sync(() => {
      const later: Grammar.Grammar<number> = Grammar.suspend(() => target)
      const g = Grammar.gen(function*() {
        const n = yield* later
        return n
      })
      const target = Grammar.integer
      assert.equal(parseOk(g, "7"), 7)
    }))

  it.effect("a gen inside a gen keeps its own bindings, and a failed inner gen backtracks", () =>
    Effect.sync(() => {
      const pair = Grammar.gen(function*() {
        const a = yield* Grammar.integer
        yield* Grammar.literal("=")
        const b = yield* Grammar.integer
        return { a, b }
      })
      const g = Grammar.gen(function*() {
        const first = yield* Grammar.choice([pair, Grammar.integer])
        yield* Grammar.literal(";")
        const second = yield* pair
        return { first, second }
      })
      assert.deepEqual(parseOk(g, "1;2=3"), { first: 1, second: { a: 2, b: 3 } })
      assert.deepEqual(parseOk(g, "1=2;3=4"), { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } })
    }))

  it.effect("keeps a computed __proto__ return field as an own property", () =>
    Effect.sync(() => {
      const inner = Grammar.gen(function*() {
        const value = yield* Grammar.integer
        return { value }
      })
      const key = "__proto__"
      const grammar = Grammar.gen(function*() {
        const value = yield* inner
        return { [key]: value }
      })

      const result = parseOk(grammar, "1")
      assert.equal(Object.hasOwn(result, key), true)
      assert.equal(Object.getPrototypeOf(result), Object.prototype)
      assert.equal(Object.getOwnPropertyDescriptor(result, key)?.enumerable, true)
      assert.deepEqual(result[key], { value: 1 })
      assert.equal(printOk(grammar, result), "1")
    }))

  it.effect("rejects value as the taggedChoice tag", () =>
    Effect.sync(() => {
      // @ts-expect-error "value" is reserved for the branch payload
      assert.throws(() => Grammar.taggedChoice("value", [["number", Grammar.integer]] as const), /reserved/)
    }))

  it.effect("rejects left recursion without overflowing the stack", () =>
    Effect.sync(() => {
      const recursive: Grammar.Grammar<void> = Grammar.suspend(() => recursive, "recursive")
      assert.match(parseFail(recursive, "").message, /non-left-recursive/)
    }))

  it.effect("rejects an invalid suspend target", () =>
    Effect.sync(() => {
      // SAFETY: deliberately invalid return value exercises runtime validation.
      const invalid = Grammar.suspend(() => undefined as never, "invalid")
      assert.match(parseFail(invalid, "").message, /thunk must return a grammar/)
    }))

  it.effect("does not mutate a caller-owned RegExp", () =>
    Effect.sync(() => {
      const expression = /a/g
      expression.lastIndex = 1
      const grammar = Grammar.regex(expression, "a")
      assert.equal(parseOk(grammar, "a"), "a")
      assert.equal(expression.lastIndex, 1)
    }))

  it.effect("prints object patterns exactly", () =>
    Effect.sync(() => {
      const grammar = Grammar.struct({ value: Grammar.integer })
      // SAFETY: deliberately ill-typed value exercises exact object validation.
      assert.match(printFail(grammar, { value: 1, extra: true } as never).message, /unexpected own field/)
    }))

  it.effect("preview and object inspection errors survive hostile coercion", () =>
    Effect.sync(() => {
      const hostile = Object.create(null, {
        toJSON: {
          value: () => {
            throw new Error("no json")
          },
        },
        toString: {
          value: () => {
            throw new Error("no string")
          },
        },
      })
      assert.equal(
        Grammar.PrintError.format({ _tag: "TypeMismatch", expected: "x", actual: hostile }),
        "expected x, got <unprintable value>",
      )

      const target = { value: 1 }
      const proxy = new Proxy(target, {
        ownKeys: () => {
          throw hostile
        },
      })
      assert.match(printFail(Grammar.struct({ value: Grammar.integer }), proxy).message, /<unprintable value>/)
    }))
})
