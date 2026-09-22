import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import * as Grammar from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const G = Grammar

const word = G.regex(/[a-z]+/, "word")

describe("literal", () => {
  const g = G.literal("hello")

  it.effect("parses exactly and yields no value", () =>
    Effect.sync(() => {
      assert.equal(parseOk(g, "hello"), undefined)
    }),
  )

  it.effect("fails with position, expected, and found", () =>
    Effect.sync(() => {
      const e = parseFail(g, "help")
      assert.equal(e.pos, 3)
      assert.deepEqual(e.expected, ['"hello"'])
      assert.equal(e.found, "p")
      assert.equal(e.message, 'line 1, column 4: expected "hello", found "p"')
    }),
  )

  it.effect("reports end of input", () =>
    Effect.sync(() => {
      assert.equal(parseFail(g, "").found, undefined)
      assert.match(parseFail(g, "").message, /found end of input/)
    }),
  )

  it.effect("prints itself", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, undefined), "hello")
      assertRoundTrip(g, undefined)
    }),
  )
})

describe("regex", () => {
  it.effect("parses a match anchored at the cursor", () =>
    Effect.sync(() => {
      assert.equal(parseOk(word, "abc"), "abc")
      assert.deepEqual(parseFail(word, "1abc").expected, ["word"])
    }),
  )

  it.effect("prints a matching string and rejects a non-matching one", () =>
    Effect.sync(() => {
      assert.equal(printOk(word, "xyz"), "xyz")
      assert.equal(printFail(word, "x1").message, 'expected /[a-z]+/, got "x1"')
    }),
  )

  it.effect("ignores g and y flags", () =>
    Effect.sync(() => {
      const sticky = G.regex(/\d/gy, "digit")
      assert.deepEqual(parseOk(sticky.pipe(G.many()), "123"), ["1", "2", "3"])
    }),
  )

  it.effect("rejects a Unicode match that starts before the cursor", () =>
    Effect.sync(() => {
      const error = parseFail(G.regex(/./u, "point").pipe(G.prefix("\ud83d")), "😀x")
      assert.equal(error.pos, 1)
      assert.deepEqual(error.expected, ["point"])
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(word, "roundtrip")
    }),
  )
})

describe("gen", () => {
  const endpoint = G.gen(function* () {
    yield* G.literal("https://")
    const host = yield* G.regex(/[^:/]+/, "host")
    const port = yield* G.optional(G.integer.pipe(G.prefix(":")))
    return { host, port }
  })

  it.effect("parses the steps in order and fills the returned pattern", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(endpoint, "https://x:8080"), { host: "x", port: 8080 })
      assert.deepEqual(parseOk(endpoint, "https://x"), { host: "x", port: undefined })
    }),
  )

  it.effect("prints by reading each binding back out of the value", () =>
    Effect.sync(() => {
      assert.equal(printOk(endpoint, { host: "x", port: 443 }), "https://x:443")
      assert.equal(printOk(endpoint, { host: "x", port: undefined }), "https://x")
      assertRoundTrip(endpoint, { host: "x", port: 443 })
    }),
  )

  it.effect("fails at the broken step", () =>
    Effect.sync(() => {
      const e = parseFail(endpoint, "https://x:abc")
      assert.equal(e.pos, 10)
      assert.deepEqual(e.expected, ["integer"])
    }),
  )

  it.effect("runs the generator once, at construction", () =>
    Effect.sync(() => {
      let runs = 0
      const g = G.gen(function* () {
        runs++
        const n = yield* G.integer
        return { n }
      })
      assert.equal(runs, 1)
      parseOk(g, "1")
      printOk(g, { n: 2 })
      G.render(g)
      assert.equal(runs, 1)
    }),
  )

  it.effect("returns a bare ref, a tuple, a nested object, or constants", () =>
    Effect.sync(() => {
      const bare = G.gen(function* () {
        yield* G.literal("(")
        const n = yield* G.integer
        yield* G.literal(")")
        return n
      })
      assert.equal(parseOk(bare, "(7)"), 7)
      assert.equal(printOk(bare, 7), "(7)")

      const tuple = G.gen(function* () {
        const a = yield* G.integer
        yield* G.literal(",")
        const b = yield* G.integer
        return [a, b]
      })
      assert.deepEqual(parseOk(tuple, "1,2"), [1, 2])
      assert.equal(printOk(tuple, [3, 4]), "3,4")
      assert.match(printFail(tuple, [1, 2, 3]).message, /expected 2 items/)

      const nested = G.gen(function* () {
        const host = yield* word
        yield* G.literal(":")
        const port = yield* G.integer
        return { kind: "endpoint", address: { host, port } }
      })
      assert.deepEqual(parseOk(nested, "x:1"), {
        kind: "endpoint",
        address: { host: "x", port: 1 },
      })
      assert.equal(printOk(nested, { kind: "endpoint", address: { host: "y", port: 2 } }), "y:2")
      const other: Grammar.Grammar<{ kind: string; address: { host: string; port: number } }> = nested
      assert.match(printFail(other, { kind: "other", address: { host: "y", port: 2 } }).message, /expected "endpoint"/)
    }),
  )

  it.effect("is silent when nothing is bound and nothing is returned", () =>
    Effect.sync(() => {
      const s: Grammar.Grammar<void> = G.gen(function* () {
        yield* G.literal("a")
        yield* G.optional(G.literal("b"))
      })
      assert.equal(parseOk(s, "ab"), undefined)
      assert.equal(printOk(s, undefined), "a")
      const outer = G.gen(function* () {
        yield* s
        const n = yield* G.integer
        return { n }
      })
      assert.deepEqual(parseOk(outer, "ab1"), { n: 1 })
    }),
  )

  it.effect("reports a binding that is not returned, and fails to print it", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const a = yield* G.integer
        yield* G.literal(",")
        yield* G.regex(/\d+/, "digits")
        return { a }
      })
      assert.deepEqual(parseOk(g, "1,2"), { a: 1 })
      assert.deepEqual(
        G.diagnose(g).map((issue) => issue.message),
        ["gen: step 3 (digits) is parsed but not returned; return it, or discard it with skip"],
      )
      assert.match(printFail(g, { a: 1 }).message, /step 3 \(digits\): parsed but not returned/)
    }),
  )

  it.effect("rejects a binding returned twice, at construction", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function* () {
            const a = yield* G.integer
            return { a, b: a }
          }),
        /returned twice/,
      )
    }),
  )

  it.effect("reshapes whole refs with a transform and rejects property returns", () =>
    Effect.sync(() => {
      const pair = G.gen(function* () {
        const a = yield* G.integer
        const b = yield* G.integer.pipe(G.prefix(","))
        return { a, b }
      })
      const renamed = G.gen(function* () {
        const p = yield* pair
        return p
      }).pipe(
        G.transform({
          decode: ({ a, b }) => ({ first: a, second: b }),
          encode: ({ first, second }) => ({ a: first, b: second }),
        }),
      )
      assert.deepEqual(parseOk(renamed, "1,2"), { first: 1, second: 2 })
      assert.equal(printOk(renamed, { first: 3, second: 4 }), "3,4")
      assert.throws(
        () =>
          G.gen(function* () {
            const p = yield* pair
            return G.get(p, "a")
          }),
        /property ref; return the whole bound ref/,
      )
    }),
  )

  it.effect("rejects a ref that leaks out of its gen", () =>
    Effect.sync(() => {
      let leaked: Grammar.Ref<number> | undefined
      G.gen(function* () {
        const n = yield* G.integer
        leaked = n
        return n
      })
      assert.ok(leaked !== undefined)
      assert.throws(() => G.take(leaked!), /out of scope/)
      assert.throws(
        () =>
          G.gen(function* () {
            yield* G.literal("x")
            return leaked
          }),
        /bound by another gen/,
      )
    }),
  )

  it.effect("rejects a ref used in a JavaScript expression", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function* () {
            const n = yield* G.integer
            // oxlint-disable-next-line typescript/no-base-to-string, typescript/restrict-template-expressions
            return { label: `${n}` }
          }),
        /Grammar\.Ref has no value/,
      )
    }),
  )

  it.effect("rejects a returned grammar and a yielded non-grammar", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function* () {
            yield* G.literal("x")
            return G.integer
          }),
        /holds a grammar/,
      )
      assert.throws(
        () =>
          G.gen(function* () {
            // SAFETY: deliberately wrong; the runtime must reject it.
            yield [G.integer] as any
          }),
        /only a grammar/,
      )
    }),
  )
})

describe("match", () => {
  const kindOf = G.choice(G.literal("n:").pipe(G.as("num")), G.literal("w:").pipe(G.as("word")))
  const tagged = G.gen(function* () {
    const kind = yield* kindOf
    const value = yield* G.match(kind, [
      ["num", G.integer],
      ["word", word],
    ] as const)
    return { kind, value }
  })

  it.effect("picks the case by an earlier binding, both ways", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(tagged, "n:12"), { kind: "num", value: 12 })
      assert.deepEqual(parseOk(tagged, "w:ab"), { kind: "word", value: "ab" })
      assert.equal(printOk(tagged, { kind: "word", value: "zz" }), "w:zz")
      assert.equal(printOk(tagged, { kind: "num", value: 5 }), "n:5")
      assert.match(printFail(tagged, { kind: "num", value: "zz" }).message, /integer/)
    }),
  )

  it.effect("branches on a property of a binding", () =>
    Effect.sync(() => {
      const header = G.gen(function* () {
        const kind = yield* G.choice(G.literal("t").pipe(G.as("text")), G.literal("b").pipe(G.as("bin")))
        const size = yield* G.integer
        return { kind, size }
      })
      const frame = G.gen(function* () {
        const h = yield* header
        yield* G.literal(":")
        const body = yield* G.match(G.get(h, "kind"), [
          ["text", G.take(G.get(h, "size"))],
          ["bin", G.regex(/[01]/, "bit").pipe(G.repeat(G.get(h, "size")))],
        ] as const)
        return { h, body }
      })
      assert.deepEqual(parseOk(frame, "t3:abc"), { h: { kind: "text", size: 3 }, body: "abc" })
      assert.deepEqual(parseOk(frame, "b2:01"), { h: { kind: "bin", size: 2 }, body: ["0", "1"] })
      assert.equal(printOk(frame, { h: { kind: "text", size: 2 }, body: "xy" }), "t2:xy")
      assert.equal(
        G.render(frame),
        'h:(kind:("t" | "b") size:<integer>) ":" body:match(h.kind){"text" => <take>{h.size} | "bin" => (<bit>){h.size}}',
      )
    }),
  )

  it.effect("fails to parse when no case matches a runtime string", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        // SAFETY: parsed text can hold any word; the type only records the cases we branch on.
        const kind = (yield* word) as Grammar.Ref<"num">
        yield* G.literal(":")
        const value = yield* G.match(kind, [["num", G.integer]] as const)
        return { kind, value }
      })
      assert.deepEqual(parseFail(g, "str:1").expected, ['a match case for "str"'])
    }),
  )
})

describe("take / repeat", () => {
  const netstring = G.gen(function* () {
    const length = yield* G.integer
    yield* G.literal(":")
    const payload = yield* G.take(length)
    yield* G.literal(",")
    return { length, payload }
  })

  it.effect("take reads as many characters as an earlier binding says", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(netstring, "5:hello,"), { length: 5, payload: "hello" })
      assert.deepEqual(parseOk(netstring, "0:,"), { length: 0, payload: "" })
      const e = parseFail(netstring, "5:hi,")
      assert.equal(e.pos, 5)
      assert.deepEqual(e.expected, ["5 more characters"])
      assert.equal(e.message, "line 1, column 6: expected 5 more characters, found end of input")
    }),
  )

  it.effect("printing requires the count, since nothing derives it", () =>
    Effect.sync(() => {
      // SAFETY: deliberately omitting the length to show printing requires it.
      const value = { payload: "round trip" } as Grammar.Type<typeof netstring>
      const e = printFail(netstring, value)
      assert.match(e.message, /\.length: missing field/)
      assertRoundTrip(netstring, { length: 5, payload: "a:b,c" })
    }),
  )

  it.effect("rejects a count that is not a non-negative integer", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(netstring, "-1:,").expected, ["take{-1}"])
    }),
  )

  it.effect("repeat reads a counted list", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const n = yield* G.integer
        yield* G.literal("/")
        const items = yield* G.regex(/[a-z]/, "letter").pipe(G.repeat(n))
        return { n, items }
      })
      assert.deepEqual(parseOk(g, "2/ab"), { n: 2, items: ["a", "b"] })
      assert.equal(printOk(g, { n: 3, items: ["x", "y", "z"] }), "3/xyz")
      assert.equal(G.render(g), 'n:<integer> "/" items:(<letter>){n}')
    }),
  )

  it.effect("repeat accepts a constant count", () =>
    Effect.sync(() => {
      const pair = G.regex(/[a-z]/, "letter").pipe(G.repeat(2))
      assert.deepEqual(parseOk(pair, "ab"), ["a", "b"])
      assert.deepEqual(parseFail(pair, "a").expected, ["letter"])
      assert.equal(printOk(pair, ["x", "y"]), "xy")
      assert.match(printFail(pair, ["x"]).message, /2/)
      assert.equal(G.render(pair), "(<letter>){2}")
      assert.throws(() => G.integer.pipe(G.repeat(-1)), /repeat: count must be a non-negative safe integer/)
      assert.deepEqual(G.diagnose(G.integer.pipe(G.repeat(0), G.many())).length, 1)
      assert.deepEqual(G.diagnose(G.integer.pipe(G.repeat(1), G.many())), [])
    }),
  )
})

describe("wrap / prefix / suffix", () => {
  const g = G.integer.pipe(G.between("[", "]"))

  it.effect("keeps only the inner value", () =>
    Effect.sync(() => {
      assert.equal(parseOk(g, "[5]"), 5)
      assert.equal(parseOk(G.integer.pipe(G.prefix("#")), "#5"), 5)
      assert.equal(parseOk(G.integer.pipe(G.suffix(";")), "5;"), 5)
    }),
  )

  it.effect("fails on a missing delimiter", () =>
    Effect.sync(() => {
      const e = parseFail(g, "[5")
      assert.deepEqual(e.expected, ['"]"'])
      assert.equal(e.pos, 2)
    }),
  )

  it.effect("prints the delimiters", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, 9), "[9]")
      assertRoundTrip(g, 9)
    }),
  )

  it.effect("is silent when the inner is silent", () =>
    Effect.sync(() => {
      const s = G.literal("x").pipe(G.between("<", ">"))
      const outer = G.gen(function* () {
        yield* s
        const n = yield* G.integer
        return { n }
      })
      assert.deepEqual(parseOk(outer, "<x>1"), { n: 1 })
      assert.equal(printOk(outer, { n: 1 }), "<x>1")
    }),
  )
})

describe("seq", () => {
  const s = G.seq(G.literal("a"), G.literal("b"))

  it.effect("is a silent sequence", () =>
    Effect.sync(() => {
      assert.equal(parseOk(s, "ab"), undefined)
      assert.equal(printOk(s, undefined), "ab")
      assert.equal(G.render(s), '"a" "b"')
    }),
  )
})

describe("choice", () => {
  const g = G.choice(G.literal("ab").pipe(G.as<string>("ab")), G.literal("ac").pipe(G.as<string>("ac")))

  it.effect("backtracks: a later option can match after an earlier one consumed input", () =>
    Effect.sync(() => {
      assert.equal(parseOk(g, "ab"), "ab")
      assert.equal(parseOk(g, "ac"), "ac")
    }),
  )

  it.effect("merges every expectation at the furthest position", () =>
    Effect.sync(() => {
      const e = parseFail(g, "ad")
      assert.equal(e.pos, 1)
      assert.deepEqual(e.expected, ['"ab"', '"ac"'])
      assert.match(e.message, /expected one of "ab", "ac"/)
    }),
  )

  it.effect("prints the first option that accepts the value, and lists every reason when none does", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, "ac"), "ac")
      const e = printFail(g, "zz")
      assert.match(e.message, /no choice branch accepts "zz"/)
      assert.match(e.message, /expected "ab"/)
      assert.match(e.message, /expected "ac"/)
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, "ab")
      assertRoundTrip(g, "ac")
    }),
  )
})

describe("optional", () => {
  const g = G.gen(function* () {
    const sign = yield* G.optional(G.literal("-").pipe(G.as(true)))
    const n = yield* G.integer
    return { sign, n }
  })

  it.effect("parses present and absent", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, "-4"), { sign: true, n: 4 })
      assert.deepEqual(parseOk(g, "4"), { sign: undefined, n: 4 })
    }),
  )

  it.effect("prints undefined as nothing", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, { sign: undefined, n: 4 }), "4")
      assert.equal(printOk(g, { sign: true, n: 4 }), "-4")
    }),
  )

  it.effect("is silent when the inner is silent, and prints nothing", () =>
    Effect.sync(() => {
      const trailing = G.gen(function* () {
        const n = yield* G.integer
        yield* G.optional(G.literal(","))
        return { n }
      })
      assert.deepEqual(parseOk(trailing, "1,"), { n: 1 })
      assert.equal(printOk(trailing, { n: 1 }), "1")
    }),
  )
})

describe("many", () => {
  const g = G.regex(/[a-z]/, "letter").pipe(G.many())

  it.effect("parses zero or more", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, ""), [])
      assert.deepEqual(parseOk(g, "abc"), ["a", "b", "c"])
    }),
  )

  it.effect("stops before a failing element and leaves it for what follows", () =>
    Effect.sync(() => {
      const e = parseFail(g, "ab1")
      assert.equal(e.pos, 2)
      assert.deepEqual(e.expected, ["letter", "end of input"])
    }),
  )

  it.effect("honours min and max", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(G.regex(/[a-z]/, "letter").pipe(G.many({ min: 2 })), "a").expected, ["letter"])
      assert.deepEqual(parseOk(G.regex(/[a-z]/, "letter").pipe(G.many({ max: 2 })), "ab"), ["a", "b"])
      assert.equal(parseFail(G.regex(/[a-z]/, "letter").pipe(G.many({ max: 2 })), "abc").pos, 2)
    }),
  )

  it.effect("rejects invalid bounds", () =>
    Effect.sync(() => {
      for (const min of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => G.integer.pipe(G.many({ min })), RangeError)
      }
      assert.throws(() => G.integer.pipe(G.many({ min: 3, max: 2 })), RangeError)
    }),
  )

  it.effect("prints by concatenation and checks bounds", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, ["x", "y"]), "xy")
      assert.match(printFail(G.integer.pipe(G.many({ min: 1 })), []).message, /at least 1/)
      assert.match(printFail(G.integer.pipe(G.many({ max: 1 })), [1, 2]).message, /0..1/)
    }),
  )

  it.effect("rejects a zero-width element when parsing", () =>
    Effect.sync(() => {
      const e = parseFail(G.regex(/x*/, "xs").pipe(G.many()), "abc")
      assert.deepEqual(e.expected, ["a repetition element that consumes input"])
    }),
  )

  it.effect("is pipeable", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(G.integer.pipe(G.many({ min: 1 })), "1"), [1])
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, ["a", "b"])
    }),
  )
})

describe("sepBy", () => {
  const g = G.integer.pipe(G.sepBy(","))

  it.effect("parses empty, one, and many", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, ""), [])
      assert.deepEqual(parseOk(g, "1"), [1])
      assert.deepEqual(parseOk(g, "1,2,3"), [1, 2, 3])
    }),
  )

  it.effect("leaves a trailing separator unconsumed", () =>
    Effect.sync(() => {
      const e = parseFail(g, "1,2,")
      assert.equal(e.pos, 4)
      assert.deepEqual(e.expected, ["integer"])
    }),
  )

  it.effect("honours min", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(G.integer.pipe(G.sepBy(",", { min: 1 })), "").expected, ["integer"])
    }),
  )

  it.effect("is pipeable", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(G.integer.pipe(G.sepBy(",", { min: 1 })), "1,2"), [1, 2])
    }),
  )

  it.effect("prints with separators", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, [1, 2]), "1,2")
      assert.equal(printOk(g, []), "")
      assertRoundTrip(g, [1, 2, 3])
    }),
  )
})

describe("transform / decodeTo", () => {
  it.effect("maps both ways", () =>
    Effect.sync(() => {
      const g = G.regex(/\d+/, "digits").pipe(G.transform({ decode: Number, encode: String }))
      assert.equal(parseOk(g, "12"), 12)
      assert.equal(printOk(g, 12), "12")
    }),
  )

  it.effect("`is` guards both parse and print", () =>
    Effect.sync(() => {
      const even = G.integer.pipe(
        G.transform({ decode: (n) => n, encode: (n) => n }),
        G.filter((n: number) => n % 2 === 0, "even"),
      )
      assert.deepEqual(parseFail(even, "3").expected, ["even"])
      assert.match(printFail(even, 3).message, /even/)
    }),
  )

  it.effect("decodeTo uses the schema as the guard, so choice can pick a branch when printing", () =>
    Effect.sync(() => {
      const Num = Schema.Struct({ kind: Schema.Literal("num"), value: Schema.Finite })
      const Word = Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String })
      const num = G.integer.pipe(
        G.decodeTo(Num)({ decode: (value) => ({ kind: "num", value }), encode: (n) => n.value }),
      )
      const w = word.pipe(
        G.decodeTo(Word)({
          decode: (value) => ({ kind: "word", value }),
          encode: (w) => w.value,
        }),
      )
      const g = G.choice(num, w)
      assert.deepEqual(parseOk(g, "12"), { kind: "num", value: 12 })
      assert.equal(printOk(g, { kind: "word", value: "ab" }), "ab")
      assert.equal(printOk(g, { kind: "num", value: 3 }), "3")
      assertRoundTrip(g, { kind: "word", value: "ab" })
    }),
  )

  it.effect("decodeTo rejects on parse when the schema does", () =>
    Effect.sync(() => {
      const Small = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 }))
      const g = G.integer.pipe(G.decodeTo(Small, "digit")({ decode: (n) => n, encode: (n) => n }))
      assert.deepEqual(parseFail(g, "10").expected, ["digit"])
    }),
  )

  it.effect("decodeTo names the schema guard by default", () =>
    Effect.sync(() => {
      const Small = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 }))
      const g = G.integer.pipe(G.decodeTo(Small)({ decode: (n) => n, encode: (n) => n }))
      assert.equal(parseOk(g, "9"), 9)
      assert.deepEqual(parseFail(g, "10").expected, ["a value matching the schema"])
      assert.match(printFail(g, 10).message, /a value matching the schema/)
    }),
  )

  it.effect("a transform over take composes both ways", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const n = yield* G.integer
        yield* G.literal(":")
        const chars = yield* G.take(n).pipe(
          G.transform({
            decode: (s: string) => s.split(""),
            encode: (cs) => cs.join(""),
          }),
        )
        return { n, chars }
      })
      assert.deepEqual(parseOk(g, "2:ab"), { n: 2, chars: ["a", "b"] })
      assert.equal(printOk(g, { n: 3, chars: ["x", "y", "z"] }), "3:xyz")
    }),
  )
})

describe("as / flag / skip", () => {
  it.effect("as gives a silent grammar a constant, and prints only for that constant", () =>
    Effect.sync(() => {
      const g = G.choice(G.literal("yes").pipe(G.as(true)), G.literal("no").pipe(G.as(false)))
      assert.equal(parseOk(g, "no"), false)
      assert.equal(printOk(g, true), "yes")
      assert.equal(printOk(g, false), "no")
      assertRoundTrip(g, false)
    }),
  )

  it.effect("literals yields the matched string and prints only its own strings", () =>
    Effect.sync(() => {
      const op = G.literals(">=", ">")
      assert.equal(parseOk(op, ">="), ">=")
      assert.equal(parseOk(op, ">"), ">")
      assert.equal(printOk(op, ">"), ">")
      assert.deepEqual(parseFail(op, "<").expected, ['">="', '">"'])
      // SAFETY: deliberately printing a string outside the union.
      assert.match(printFail(op, "<" as Grammar.Type<typeof op>).message, /expected ">"/)
      assert.equal(G.render(op), '(">=" | ">")')
    }),
  )

  it.effect("literals tries longer strings first, whatever order they are listed in", () =>
    Effect.sync(() => {
      const op = G.literals("", ">", "<", ">=")
      assert.equal(parseOk(op, ">="), ">=")
      assert.equal(parseOk(op, ""), "")
      assert.equal(G.render(G.literals(">", "<", ">=")), '(">=" | ">" | "<")')
    }),
  )

  it.effect("flag is presence as a boolean", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const neg = yield* G.flag("-")
        const n = yield* G.integer
        return { neg, n }
      })
      assert.deepEqual(parseOk(g, "-1"), { neg: true, n: 1 })
      assert.deepEqual(parseOk(g, "1"), { neg: false, n: 1 })
      assert.equal(printOk(g, { neg: true, n: 2 }), "-2")
      assert.equal(printOk(g, { neg: false, n: 2 }), "2")
    }),
  )

  it.effect("skip discards a value and prints the canonical form", () =>
    Effect.sync(() => {
      const ws = G.regex(/\s+/, "space").pipe(G.skip(" "))
      const g = G.gen(function* () {
        const a = yield* G.integer
        yield* ws
        const b = yield* G.integer
        return { a, b }
      })
      assert.deepEqual(parseOk(g, "1    2"), { a: 1, b: 2 })
      assert.equal(printOk(g, { a: 1, b: 2 }), "1 2")
      assert.deepEqual(parseFail(g, "12").expected, ["space"])
    }),
  )
})

describe("lexeme / symbol / trivia", () => {
  const g = G.lexeme(G.integer).pipe(G.sepBy(G.symbol(",")), G.between(G.symbol("["), G.symbol("]")))

  it.effect("skips trailing whitespace after tokens", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(g, "[ 1 ,2,  3 ]"), [1, 2, 3])
    }),
  )

  it.effect("prints no implicit trivia", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, [1, 2]), "[1,2]")
      assertRoundTrip(g, [1, 2])
    }),
  )

  it.effect("trivia is silent, optional, and hidden from render", () =>
    Effect.sync(() => {
      const spaced = G.integer.pipe(G.between(G.trivia, G.trivia))
      assert.equal(parseOk(spaced, "  4 "), 4)
      assert.equal(printOk(spaced, 4), "4")
      assert.equal(G.render(spaced), "<integer>")
    }),
  )
})

describe("label", () => {
  const g = G.gen(function* () {
    const a = yield* G.regex(/[a-z]/, "letter")
    const b = yield* G.regex(/\d/, "digit")
    return { a, b }
  }).pipe(G.label("pair"))

  it.effect("replaces the expected set when failing at its own start", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(g, "1").expected, ["pair"])
    }),
  )

  it.effect("keeps sibling expectations recorded at the same position", () =>
    Effect.sync(() => {
      const c = G.choice(G.literal("x"), g, G.regex(/\d/, "digit").pipe(G.label("num")))
      assert.deepEqual(parseFail(c, "!").expected, ['"x"', "pair", "num"])
    }),
  )

  it.effect("keeps the deeper expectation after consuming input", () =>
    Effect.sync(() => {
      const e = parseFail(g, "ax")
      assert.equal(e.pos, 1)
      assert.deepEqual(e.expected, ["digit"])
    }),
  )

  it.effect("is transparent to print", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, { a: "a", b: "1" }), "a1")
    }),
  )
})

describe("suspend", () => {
  type Nested = number | ReadonlyArray<Nested>
  const nested: Grammar.Grammar<Nested> = G.suspend(
    () =>
      G.choice(
        G.integer,
        nested.pipe(
          G.sepBy(","),
          G.between("[", "]"),
          G.transform({
            decode: (a): Nested => a,
            encode: (a): Array<Nested> => {
              if (!Array.isArray(a)) {
                throw new TypeError("expected array")
              }
              return a
            },
          }),
        ),
      ),
    "nested",
  )

  it.effect("parses recursion", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk(nested, "[1,[2,[]],3]"), [1, [2, []], 3])
    }),
  )

  it.effect("prints and round-trips", () =>
    Effect.sync(() => {
      assert.equal(printOk(nested, [1, [2]]), "[1,[2]]")
      assertRoundTrip(nested, [1, [2, []], 3])
    }),
  )

  it.effect("renders with the name at the recursion point", () =>
    Effect.sync(() => {
      assert.equal(G.render(nested), '(<integer> | "[" (nested ("," nested)*)? "]")')
    }),
  )
})

describe("integer", () => {
  it.effect("parses signed integers and rejects unsafe ones", () =>
    Effect.sync(() => {
      assert.equal(parseOk(G.integer, "-42"), -42)
      assert.deepEqual(parseFail(G.integer, "x").expected, ["integer"])
      assert.deepEqual(parseFail(G.integer, "99999999999999999999").expected, ["integer"])
    }),
  )

  it.effect("prints and rejects unsafe values", () =>
    Effect.sync(() => {
      assert.equal(printOk(G.integer, 7), "7")
      assert.match(printFail(G.integer, 1.5).message, /integer/)
    }),
  )
})

describe("parse", () => {
  it.effect("is strict about trailing input", () =>
    Effect.sync(() => {
      const e = parseFail(G.integer, "12x")
      assert.equal(e.pos, 2)
      assert.deepEqual(e.expected, ["end of input"])
    }),
  )

  it.effect("reports the furthest failure, with line and column", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const a = yield* G.integer
        yield* G.literal("\n")
        const b = yield* G.integer
        return { a, b }
      })
      const e = parseFail(g, "1\nx")
      assert.equal(e.line, 2)
      assert.equal(e.column, 1)
      assert.equal(e.message, 'line 2, column 1: expected integer, found "x"')
    }),
  )

  it.effect("returns a Result", () =>
    Effect.sync(() => {
      assert.ok(Result.isSuccess(G.parse(G.integer, "1")))
      assert.ok(Result.isFailure(G.parse(G.integer, "")))
    }),
  )
})

describe("render", () => {
  it.effect("shows literals, regexes, named bindings, and repetition", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        yield* G.literal("a")
        const n = yield* G.integer
        const xs = yield* G.regex(/x/, "x").pipe(G.many({ min: 1 }))
        const o = yield* G.optional(G.literal("!").pipe(G.as(true)))
        return { n, xs, o }
      })
      assert.equal(G.render(g), '"a" n:<integer> xs:(<x>)+ o:("!")?')
    }),
  )

  it.effect("names bindings by their path in the return", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        const host = yield* word
        yield* G.literal(":")
        const port = yield* G.integer
        return { address: { host }, ports: [port] }
      })
      assert.equal(G.render(g), 'address.host:<word> ":" ports.0:<integer>')
    }),
  )

  it.effect("leaves a bare return and a recovered binding unnamed", () =>
    Effect.sync(() => {
      const g = G.gen(function* () {
        yield* G.literal("<")
        const n = yield* G.integer
        yield* G.literal(">")
        return n
      })
      assert.equal(G.render(g), '"<" <integer> ">"')
    }),
  )
})

describe("codec", () => {
  const pair = G.gen(function* () {
    const name = yield* G.regex(/[a-z]+/, "name")
    yield* G.literal("=")
    const n = yield* G.integer
    return { name, n }
  })
  const Pair = G.codec(
    pair,
    Schema.Struct({
      name: Schema.String,
      n: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
    }),
    { identifier: "Pair" },
  )

  it.effect("decodes and encodes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* Schema.decodeEffect(Pair)("a=1"), { name: "a", n: 1 })
      assert.equal(yield* Schema.encodeEffect(Pair)({ name: "b", n: 2 }), "b=2")
    }),
  )

  it.effect("surfaces parse errors with position", () =>
    Effect.sync(() => {
      const r = Schema.decodeResult(Pair)("a=x")
      assert.ok(Result.isFailure(r))
      if (Result.isFailure(r)) assert.match(r.failure.message, /line 1, column 3: expected integer/)
    }),
  )

  it.effect("applies the target's refinements", () =>
    Effect.sync(() => {
      assert.ok(Result.isFailure(Schema.decodeResult(Pair)("a=10")))
    }),
  )

  it.effect("fails to encode what the grammar cannot print", () =>
    Effect.sync(() => {
      const r = Schema.encodeUnknownResult(Pair)({ name: "A", n: 1 })
      assert.ok(Result.isFailure(r))
      if (Result.isFailure(r)) assert.match(r.failure.message, /expected \/\[a-z\]\+\/, got "A"/)
    }),
  )

  it.effect("uses the rendered grammar as the description", () =>
    Effect.sync(() => {
      assert.equal(Grammar.render(pair), 'name:<name> "=" n:<integer>')
    }),
  )
})
