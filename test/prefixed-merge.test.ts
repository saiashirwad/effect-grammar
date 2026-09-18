import assert from "node:assert/strict"

import { describe, it } from "vitest"

import * as G from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const word = G.regex(/[a-z]+/, "word")

describe("take with a constant count", () => {
  const code = G.take(3)

  it("reads and prints exactly that many characters", () => {
    assert.equal(parseOk(code, "abc"), "abc")
    assert.equal(printOk(code, "abc"), "abc")
    assert.equal(G.render(code), "<char>{3}")
    assert.deepEqual(parseFail(code, "ab").expected, ["3 chars"])
    assert.match(printFail(code, "abcd").message, /3 UTF-16 code units/)
  })

  it("rejects a count that is not a non-negative safe integer", () => {
    assert.throws(() => G.take(-1), RangeError)
    assert.throws(() => G.take(1.5), RangeError)
  })

  it("lets validate prove a repetition of take(0) matches empty input", () => {
    assert.equal(G.validate(G.many(G.take(0))).length, 1)
    assert.equal(G.validate(G.many(G.take(1))).length, 0)
  })
})

describe("filter", () => {
  const small = G.integer.pipe(G.filter((n) => n >= 1 && n <= 63, "small"))

  it("accepts values the predicate accepts", () => {
    assert.equal(parseOk(small, "42"), 42)
    assert.equal(printOk(small, 42), "42")
  })

  it("rejects other values in both directions", () => {
    assert.deepEqual(parseFail(small, "64").expected, ["small"])
    assert.match(printFail(small, 0).message, /expected small/)
  })

  it("narrows with a refinement and claims an inverse", () => {
    const a: G.Grammar<"a"> = word.pipe(G.filter((text): text is "a" => text === "a", "a"))
    assert.equal(parseOk(a, "a"), "a")
    assert.deepEqual(G.auditFidelity(a), [])
  })

  it("supports the data-first form", () => {
    const positive = G.filter(G.integer, (n) => n > 0, "positive")
    assert.equal(parseOk(positive, "7"), 7)
    assert.deepEqual(parseFail(positive, "0").expected, ["positive"])
  })
})

describe("lengthPrefixed / countPrefixed", () => {
  const netstring = G.lengthPrefixed(G.integer.pipe(G.suffix(":"))).pipe(G.suffix(","))
  const words = G.countPrefixed(word.pipe(G.suffix(";")), G.integer.pipe(G.suffix(":")))

  it("derives the length from the payload when printing", () => {
    assert.equal(parseOk(netstring, "5:hello,"), "hello")
    assert.equal(printOk(netstring, "hello world!"), "12:hello world!,")
    assertRoundTrip(netstring, "")
    assert.deepEqual(parseFail(netstring, "5:hi,").expected, ["5 chars"])
  })

  it("derives the count from the items when printing", () => {
    assert.deepEqual(parseOk(words, "2:ab;cd;"), ["ab", "cd"])
    assert.equal(printOk(words, ["x", "y", "z"]), "3:x;y;z;")
    assertRoundTrip(words, [])
    assert.deepEqual(parseFail(words, "3:ab;cd;").expected, ["word"])
  })

  it("supports the data-last form", () => {
    const piped = word.pipe(G.suffix(";"), G.countPrefixed(G.integer))
    assert.deepEqual(parseOk(piped, "1a;"), ["a"])
  })
})

describe("merge", () => {
  const point = G.merge(
    G.struct({ x: G.integer }),
    G.struct({ y: G.integer.pipe(G.prefix(",")) }).pipe(G.between("", ";")),
    G.gen(function* () {
      const name = yield* word
      return { name }
    }),
  )

  it("flattens its parts into one object", () => {
    assert.deepEqual(parseOk(point, "1,2;p"), { x: 1, y: 2, name: "p" })
    assert.equal(printOk(point, { x: 1, y: 2, name: "p" }), "1,2;p")
    assert.equal(G.render(point), 'x:<integer> y:("," <integer>) ";" name:<word>')
    assertRoundTrip(point, { x: -3, y: 0, name: "q" })
  })

  it("reports a missing field by its flat path", () => {
    // SAFETY: deliberately omitting y to show the printer reports the flat path.
    const missing = { x: 1, name: "p" } as G.Type<typeof point>
    assert.match(printFail(point, missing).message, /^\.y: missing field/)
  })

  it("rejects unknown and unreadable fields", () => {
    // SAFETY: deliberately adding z to show unknown fields are rejected.
    const extra = { x: 1, y: 2, name: "p", z: 3 } as G.Type<typeof point>
    assert.match(printFail(point, extra).message, /unexpected own field/)
    const unreadable = {
      x: 1,
      y: 2,
      get name(): string {
        throw new Error("boom")
      },
    }
    assert.match(printFail(point, unreadable).message, /readable fields: boom/)
  })

  it("nests, and sees through filter and transforms that declare keys", () => {
    const tagged = G.literal("!").pipe(
      G.as("bang" as const),
      G.iso({
        decode: (kind) => ({ kind }),
        encode: ({ kind }: { readonly kind: "bang" }) => kind,
        keys: ["kind"],
      }),
    )
    const nested = G.merge(
      point.pipe(G.filter((value) => value.x >= 0, "a point right of the origin")),
      tagged,
    )
    const value: G.Type<typeof nested> = { x: 1, y: 2, name: "p", kind: "bang" }
    assert.deepEqual(parseOk(nested, "1,2;p!"), value)
    assert.equal(printOk(nested, value), "1,2;p!")
  })

  it("rejects parts without known fields and duplicate fields", () => {
    assert.throws(() => G.merge(G.struct({ x: G.integer }), G.integer), /no known fields/)
    assert.throws(
      () => G.merge(G.struct({ x: G.integer }), G.struct({ x: word })),
      /duplicate key "x"/,
    )
  })
})
