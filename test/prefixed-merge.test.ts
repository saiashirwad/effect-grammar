import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import * as G from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const word = G.regex(/[a-z]+/, "word")

describe("take with a constant count", () => {
  it.effect("reads and prints exactly that many characters", () =>
    Effect.sync(() => {
      const code = G.take(3)
      assert.equal(parseOk(code, "abc"), "abc")
      assert.deepEqual(parseFail(code, "ab").expected, ["3 more characters"])
      assert.match(printFail(code, "abcd").message, /expected 3 characters/)
      assert.throws(() => G.take(1.5), RangeError)
      assert.equal(G.validate(G.take(0).pipe(G.many())).length, 1)
    }),
  )
})

describe("filter", () => {
  it.effect("rejects values in both directions", () =>
    Effect.sync(() => {
      const small = G.integer.pipe(G.filter((n: number) => n <= 63, "small"))
      assert.equal(parseOk(small, "42"), 42)
      assert.deepEqual(parseFail(small, "64").expected, ["small"])
      assert.match(printFail(small, 64).message, /expected small/)
      assert.deepEqual(parseFail(G.integer.pipe(G.filter((n: number) => n > 0, "positive")), "0").expected, [
        "positive",
      ])
    }),
  )
})

describe("lengthPrefixed / countPrefixed", () => {
  it.effect("derives the length from the payload when printing", () =>
    Effect.sync(() => {
      const netstring = G.lengthPrefixed(G.integer.pipe(G.suffix(":"))).pipe(G.suffix(","))
      assert.equal(parseOk(netstring, "5:hello,"), "hello")
      assert.equal(printOk(netstring, "hello world!"), "12:hello world!,")
      assert.deepEqual(parseFail(netstring, "5:hi,").expected, ["5 more characters"])
    }),
  )

  it.effect("derives the count from the items when printing", () =>
    Effect.sync(() => {
      const item = word.pipe(G.suffix(";"))
      const words = item.pipe(G.countPrefixed(G.integer.pipe(G.suffix(":"))))
      assert.deepEqual(parseOk(words, "2:ab;cd;"), ["ab", "cd"])
      assert.equal(printOk(words, ["x", "y", "z"]), "3:x;y;z;")
      assert.deepEqual(parseFail(words, "3:ab;cd;").expected, ["word"])
      assert.deepEqual(parseOk(item.pipe(G.countPrefixed(G.integer)), "1a;"), ["a"])
    }),
  )
})

describe("spreading a ref", () => {
  const point = G.gen(function* () {
    const a = yield* G.struct({ x: G.integer })
    const b = yield* G.struct({ y: G.integer.pipe(G.prefix(",")) })
    return { ...a, ...b }
  })

  it.effect("flattens the fields of each spread ref, and sees through filter", () =>
    Effect.sync(() => {
      const named = G.gen(function* () {
        const p = yield* point.pipe(
          G.filter((value: G.Type<typeof point>) => value.x >= 0, "a point right of the origin"),
        )
        const name = yield* word.pipe(G.prefix(";"))
        return { ...p, name }
      })
      assert.deepEqual(parseOk(named, "1,2;p"), { x: 1, y: 2, name: "p" })
      assertRoundTrip(named, { x: 3, y: -4, name: "q" })
    }),
  )

  it.effect("returns single fields under new names", () =>
    Effect.sync(() => {
      const renamed = G.gen(function* () {
        const p = yield* point
        return { first: p.x, second: p.y }
      })
      assert.deepEqual(parseOk(renamed, "1,2"), { first: 1, second: 2 })
      assertRoundTrip(renamed, { first: 3, second: 4 })
    }),
  )

  it.effect("reports print failures by flat field path", () =>
    Effect.sync(() => {
      // SAFETY: deliberately omitting y to show the printer reports the flat path.
      const missing = { x: 1 } as G.Type<typeof point>
      assert.match(printFail(point, missing).message, /^\.y: missing field/)
      // SAFETY: deliberately adding z to show unknown fields are rejected.
      const extra = { x: 1, y: 2, z: 3 } as G.Type<typeof point>
      assert.match(printFail(point, extra).message, /unexpected own field/)
    }),
  )

  it.effect("rejects partial spreads, double returns, and refs without known fields", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function* () {
            const p = yield* point
            return { x: p.x }
          }),
        /"y" is missing/,
      )
      assert.throws(
        () =>
          G.gen(function* () {
            const p = yield* point
            return { p, ...p }
          }),
        /returned twice/,
      )
      const wrapped = word.pipe(G.iso({ decode: (w) => ({ w }), encode: ({ w }) => w }))
      assert.throws(
        () =>
          G.gen(function* () {
            const w = yield* wrapped
            return { first: w.w }
          }),
        /no known fields/,
      )
    }),
  )
})
