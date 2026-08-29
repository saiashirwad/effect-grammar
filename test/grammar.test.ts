import assert from "node:assert/strict"

import { Result, Schema } from "effect"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const G = Grammar

const word = G.regex(/[a-z]+/, "word")

describe("literal", () => {
  const g = G.literal("hello")

  it("parses exactly and yields no value", () => {
    assert.equal(parseOk(g, "hello"), undefined)
  })

  it("fails with position, expected, and found", () => {
    const e = parseFail(g, "help")
    assert.equal(e.pos, 0)
    assert.deepEqual(e.expected, ['"hello"'])
    assert.equal(e.found, "h")
    assert.equal(e.message, 'line 1, column 1: expected "hello", found "h"')
  })

  it("reports end of input", () => {
    assert.equal(parseFail(g, "").found, undefined)
    assert.match(parseFail(g, "").message, /found end of input/)
  })

  it("prints itself", () => {
    assert.equal(printOk(g, undefined), "hello")
    assertRoundTrip(g, undefined)
  })
})

describe("regex", () => {
  it("parses a match anchored at the cursor", () => {
    assert.equal(parseOk(word, "abc"), "abc")
    assert.deepEqual(parseFail(word, "1abc").expected, ["word"])
  })

  it("prints a matching string and rejects a non-matching one", () => {
    assert.equal(printOk(word, "xyz"), "xyz")
    assert.match(printFail(word, "x1").message, /does not match/)
    const badGrammar: Grammar.Grammar<unknown> = word
    const e = printFail(badGrammar, 42)
    assert.match(e.message, /expected a string/)
  })

  it("ignores g and y flags", () => {
    const sticky = G.regex(/\d/gy, "digit")
    assert.deepEqual(parseOk(G.many(sticky), "123"), ["1", "2", "3"])
  })

  it("round-trips", () => {
    assertRoundTrip(word, "roundtrip")
  })
})

describe("gen", () => {
  const endpoint = G.gen(function* () {
    yield* G.literal("https://")
    const host = yield* G.regex(/[^:/]+/, "host")
    const port = yield* G.optional(G.prefix(":", G.integer))
    return { host, port }
  })

  it("parses the steps in order and fills the returned pattern", () => {
    assert.deepEqual(parseOk(endpoint, "https://x:8080"), { host: "x", port: 8080 })
    assert.deepEqual(parseOk(endpoint, "https://x"), { host: "x", port: undefined })
  })

  it("prints by reading each binding back out of the value", () => {
    assert.equal(printOk(endpoint, { host: "x", port: 443 }), "https://x:443")
    assert.equal(printOk(endpoint, { host: "x", port: undefined }), "https://x")
    assertRoundTrip(endpoint, { host: "x", port: 443 })
  })

  it("fails at the broken step", () => {
    const e = parseFail(endpoint, "https://x:abc")
    assert.equal(e.pos, 10)
    assert.deepEqual(e.expected, ["integer"])
  })

  it("runs the generator once, at construction", () => {
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
  })

  it("returns a bare ref, a tuple, a nested object, or constants", () => {
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
    assert.deepEqual(parseOk(nested, "x:1"), { kind: "endpoint", address: { host: "x", port: 1 } })
    assert.equal(printOk(nested, { kind: "endpoint", address: { host: "y", port: 2 } }), "y:2")
    const other: Grammar.Grammar<{ kind: string; address: { host: string; port: number } }> = nested
    assert.match(
      printFail(other, { kind: "other", address: { host: "y", port: 2 } }).message,
      /expected "endpoint"/,
    )
  })

  it("is silent when nothing is bound and nothing is returned", () => {
    const s: Grammar.Silent = G.gen(function* () {
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
  })

  it("rejects a binding that is not returned, at construction", () => {
    assert.throws(
      () =>
        G.gen(function* () {
          const a = yield* G.integer
          yield* G.literal(",")
          yield* G.integer
          return { a }
        }),
      /step 3 \(<integer>\) is parsed but not returned/,
    )
  })

  it("rejects a binding returned twice, at construction", () => {
    assert.throws(
      () =>
        G.gen(function* () {
          const a = yield* G.integer
          return { a, b: a }
        }),
      /returned twice/,
    )
  })

  it("rejects a projection in the return", () => {
    assert.throws(
      () =>
        G.gen(function* () {
          const pair = yield* G.gen(function* () {
            const a = yield* G.integer
            return { a }
          })
          return pair.a
        }),
      /property of a ref/,
    )
  })

  it("rejects a ref that leaks out of its gen", () => {
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
  })

  it("rejects a ref used in a JavaScript expression", () => {
    assert.throws(
      () =>
        G.gen(function* () {
          const n = yield* G.integer
          // oxlint-disable-next-line typescript/no-base-to-string, typescript/restrict-template-expressions
          return { label: `${n}` }
        }),
      /Grammar\.Ref has no value/,
    )
  })

  it("rejects a returned grammar and a yielded non-grammar", () => {
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
  })
})

describe("match", () => {
  const kindOf = G.choice(G.literal("n:").pipe(G.as("num")), G.literal("w:").pipe(G.as("word")))
  const tagged = G.gen(function* () {
    const kind = yield* kindOf
    const value = yield* G.match(kind, { num: G.integer, word })
    return { kind, value }
  })

  it("picks the case by an earlier binding, both ways", () => {
    assert.deepEqual(parseOk(tagged, "n:12"), { kind: "num", value: 12 })
    assert.deepEqual(parseOk(tagged, "w:ab"), { kind: "word", value: "ab" })
    assert.equal(printOk(tagged, { kind: "word", value: "zz" }), "w:zz")
    assert.equal(printOk(tagged, { kind: "num", value: 5 }), "n:5")
    const loose: Grammar.Grammar<{ kind: "num" | "word"; value: unknown }> = tagged
    assert.match(printFail(loose, { kind: "num", value: "zz" }).message, /integer/)
  })

  it("recovers a scrutinee that is not returned by trying each case", () => {
    const g = G.gen(function* () {
      const kind = yield* kindOf
      const value = yield* G.match(kind, { num: G.integer, word })
      return value
    })
    assert.equal(parseOk(g, "n:12"), 12)
    assert.equal(printOk(g, 7), "n:7")
    assert.equal(printOk(g, "ab"), "w:ab")
    const loose: Grammar.Grammar<unknown> = g
    assert.match(printFail(loose, true).message, /not in the value/)
  })

  it("recovers a boolean scrutinee", () => {
    const g = G.gen(function* () {
      const quoted = yield* G.flag("'")
      const body = yield* G.match(quoted, { true: G.wrap("(", word, ")"), false: G.integer })
      return body
    })
    assert.equal(parseOk(g, "'(ab)"), "ab")
    assert.equal(parseOk(g, "12"), 12)
    assert.equal(printOk(g, "cd"), "'(cd)")
    assert.equal(printOk(g, 3), "3")
  })

  it("branches on a property of a binding", () => {
    const header = G.gen(function* () {
      const kind = yield* G.choice(
        G.literal("t").pipe(G.as("text")),
        G.literal("b").pipe(G.as("bin")),
      )
      const size = yield* G.integer
      return { kind, size }
    })
    const frame = G.gen(function* () {
      const h = yield* header
      yield* G.literal(":")
      const body = yield* G.match(h.kind, {
        text: G.take(h.size),
        bin: G.repeat(G.regex(/[01]/, "bit"), h.size),
      })
      return { h, body }
    })
    assert.deepEqual(parseOk(frame, "t3:abc"), { h: { kind: "text", size: 3 }, body: "abc" })
    assert.deepEqual(parseOk(frame, "b2:01"), { h: { kind: "bin", size: 2 }, body: ["0", "1"] })
    assert.equal(printOk(frame, { h: { kind: "text", size: 2 }, body: "xy" }), "t2:xy")
    assert.equal(
      G.render(frame),
      'h:(kind:("t" | "b") size:<integer>) ":" body:match(h.kind){text => <char>{h.size} | bin => (<bit>){h.size}}',
    )
  })

  it("fails to parse when no case matches a non-literal scrutinee", () => {
    const g = G.gen(function* () {
      const kind = yield* word
      yield* G.literal(":")
      const value = yield* G.match(kind, { num: G.integer })
      return { kind, value }
    })
    assert.deepEqual(parseFail(g, "str:1").expected, ['a match case for "str"'])
  })
})

describe("take / repeat", () => {
  const netstring = G.gen(function* () {
    const length = yield* G.integer
    yield* G.literal(":")
    const payload = yield* G.take(length)
    yield* G.literal(",")
    return payload
  })

  it("take reads as many characters as an earlier binding says", () => {
    assert.equal(parseOk(netstring, "5:hello,"), "hello")
    assert.equal(parseOk(netstring, "0:,"), "")
    const e = parseFail(netstring, "5:hi,")
    assert.equal(e.pos, 2)
    assert.deepEqual(e.expected, ["5 chars"])
  })

  it("take recovers the count when printing", () => {
    assert.equal(printOk(netstring, "round trip"), "10:round trip,")
    assertRoundTrip(netstring, "a:b,c")
  })

  it("rejects a count that is not a non-negative integer", () => {
    assert.deepEqual(parseFail(netstring, "-1:,").expected, ["<char>{-1}"])
  })

  it("repeat reads a counted list and recovers the count", () => {
    const g = G.gen(function* () {
      const n = yield* G.integer
      yield* G.literal("/")
      const items = yield* G.regex(/[a-z]/, "letter").pipe(G.repeat(n))
      return items
    })
    assert.deepEqual(parseOk(g, "2/ab"), ["a", "b"])
    assert.equal(printOk(g, ["x", "y", "z"]), "3/xyz")
    assert.match(G.render(g), /^<integer> "\/" \(<letter>\)\{\$\d+\}$/)
  })

  it("dependent takes a custom select, recover, and rendering", () => {
    const g = G.gen(function* () {
      const width = yield* G.integer
      yield* G.literal("|")
      const cell = yield* G.dependent([width], (w) => G.regex(new RegExp(`.{${w}}`), "cell"), {
        recover: (s) => [s.length],
        show: ([w]) => `<cell of ${w}>`,
      })
      return { cell }
    })
    assert.deepEqual(parseOk(g, "3|abc"), { cell: "abc" })
    assert.equal(printOk(g, { cell: "xy" }), "2|xy")
    assert.match(G.render(g), /<cell of \$\d+>/)
  })
})

describe("wrap / prefix / suffix", () => {
  const g = G.wrap("[", G.integer, "]")

  it("keeps only the inner value", () => {
    assert.equal(parseOk(g, "[5]"), 5)
    assert.equal(parseOk(G.prefix("#", G.integer), "#5"), 5)
    assert.equal(parseOk(G.suffix(G.integer, ";"), "5;"), 5)
  })

  it("fails on a missing delimiter", () => {
    const e = parseFail(g, "[5")
    assert.deepEqual(e.expected, ['"]"'])
    assert.equal(e.pos, 2)
  })

  it("prints the delimiters", () => {
    assert.equal(printOk(g, 9), "[9]")
    assertRoundTrip(g, 9)
  })

  it("is silent when the inner is silent", () => {
    const s = G.wrap("<", G.literal("x"), ">")
    const outer = G.gen(function* () {
      yield* s
      const n = yield* G.integer
      return { n }
    })
    assert.deepEqual(parseOk(outer, "<x>1"), { n: 1 })
    assert.equal(printOk(outer, { n: 1 }), "<x>1")
  })
})

describe("seq", () => {
  const s = G.seq(G.literal("a"), G.literal("b"))

  it("is a silent sequence", () => {
    assert.equal(parseOk(s, "ab"), undefined)
    assert.equal(printOk(s, undefined), "ab")
    assert.equal(G.render(s), '"a" "b"')
  })
})

describe("choice", () => {
  const g = G.choice(G.literal("ab").pipe(G.as("ab")), G.literal("ac").pipe(G.as("ac")))

  it("backtracks: a later option can match after an earlier one consumed input", () => {
    assert.equal(parseOk(g, "ab"), "ab")
    assert.equal(parseOk(g, "ac"), "ac")
  })

  it("merges every expectation at the furthest position", () => {
    const e = parseFail(g, "ad")
    assert.equal(e.pos, 0)
    assert.deepEqual(e.expected, ['"ab"', '"ac"'])
    assert.match(e.message, /expected one of "ab", "ac"/)
  })

  it("prints the first option that accepts the value, and lists every reason when none does", () => {
    assert.equal(printOk(g, "ac"), "ac")
    const badGrammar: Grammar.Grammar<string> = g
    const e = printFail(badGrammar, "zz")
    assert.match(e.message, /no choice branch accepts "zz"/)
    assert.match(e.message, /expected "ab"/)
    assert.match(e.message, /expected "ac"/)
  })

  it("round-trips", () => {
    assertRoundTrip(g, "ab")
    assertRoundTrip(g, "ac")
  })
})

describe("optional", () => {
  const g = G.gen(function* () {
    const sign = yield* G.optional(G.literal("-").pipe(G.as(true)))
    const n = yield* G.integer
    return { sign, n }
  })

  it("parses present and absent", () => {
    assert.deepEqual(parseOk(g, "-4"), { sign: true, n: 4 })
    assert.deepEqual(parseOk(g, "4"), { sign: undefined, n: 4 })
  })

  it("prints undefined as nothing", () => {
    assert.equal(printOk(g, { sign: undefined, n: 4 }), "4")
    assert.equal(printOk(g, { sign: true, n: 4 }), "-4")
  })

  it("is silent when the inner is silent, and prints nothing", () => {
    const trailing = G.gen(function* () {
      const n = yield* G.integer
      yield* G.optional(G.literal(","))
      return { n }
    })
    assert.deepEqual(parseOk(trailing, "1,"), { n: 1 })
    assert.equal(printOk(trailing, { n: 1 }), "1")
  })
})

describe("many", () => {
  const g = G.many(G.regex(/[a-z]/, "letter"))

  it("parses zero or more", () => {
    assert.deepEqual(parseOk(g, ""), [])
    assert.deepEqual(parseOk(g, "abc"), ["a", "b", "c"])
  })

  it("stops before a failing element and leaves it for what follows", () => {
    const e = parseFail(g, "ab1")
    assert.equal(e.pos, 2)
    assert.deepEqual(e.expected, ["letter", "end of input"])
  })

  it("honours min and max", () => {
    assert.deepEqual(parseFail(G.many(G.regex(/[a-z]/, "letter"), { min: 2 }), "a").expected, [
      "letter",
    ])
    assert.deepEqual(parseOk(G.many(G.regex(/[a-z]/, "letter"), { max: 2 }), "ab"), ["a", "b"])
    assert.equal(parseFail(G.many(G.regex(/[a-z]/, "letter"), { max: 2 }), "abc").pos, 2)
  })

  it("rejects invalid bounds", () => {
    for (const min of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => G.many(G.integer, { min }), RangeError)
    }
    assert.throws(() => G.many(G.integer, { min: 3, max: 2 }), RangeError)
  })

  it("prints by concatenation and checks bounds", () => {
    assert.equal(printOk(g, ["x", "y"]), "xy")
    assert.match(printFail(G.many(G.integer, { min: 1 }), []).message, /at least 1/)
    assert.match(printFail(G.many(G.integer, { max: 1 }), [1, 2]).message, /0..1/)
  })

  it("throws on a zero-width element", () => {
    assert.throws(() => G.parse(G.many(G.regex(/x*/, "xs")), "y"), /without consuming/)
  })

  it("is pipeable", () => {
    assert.deepEqual(parseOk(G.integer.pipe(G.many({ min: 1 })), "1"), [1])
  })

  it("round-trips", () => {
    assertRoundTrip(g, ["a", "b"])
  })
})

describe("sepBy", () => {
  const g = G.sepBy(G.integer, ",")

  it("parses empty, one, and many", () => {
    assert.deepEqual(parseOk(g, ""), [])
    assert.deepEqual(parseOk(g, "1"), [1])
    assert.deepEqual(parseOk(g, "1,2,3"), [1, 2, 3])
  })

  it("leaves a trailing separator unconsumed", () => {
    const e = parseFail(g, "1,2,")
    assert.equal(e.pos, 4)
    assert.deepEqual(e.expected, ["integer"])
  })

  it("honours min", () => {
    assert.deepEqual(parseFail(G.sepBy(G.integer, ",", { min: 1 }), "").expected, ["integer"])
  })

  it("is pipeable", () => {
    assert.deepEqual(parseOk(G.integer.pipe(G.sepBy(",", { min: 1 })), "1,2"), [1, 2])
  })

  it("prints with separators", () => {
    assert.equal(printOk(g, [1, 2]), "1,2")
    assert.equal(printOk(g, []), "")
    assertRoundTrip(g, [1, 2, 3])
  })
})

describe("transform / decodeTo", () => {
  it("maps both ways", () => {
    const g = G.regex(/\d+/, "digits").pipe(G.transform({ decode: Number, encode: String }))
    assert.equal(parseOk(g, "12"), 12)
    assert.equal(printOk(g, 12), "12")
  })

  it("`is` guards both parse and print", () => {
    const even = G.integer.pipe(
      G.transform({
        decode: (n) => n,
        encode: (n) => n,
        is: (n: number) => n % 2 === 0,
        name: "even",
      }),
    )
    assert.deepEqual(parseFail(even, "3").expected, ["even"])
    assert.match(printFail(even, 3).message, /even/)
  })

  it("decodeTo uses the schema as the guard, so choice can pick a branch when printing", () => {
    const Num = Schema.Struct({ kind: Schema.Literal("num"), value: Schema.Finite })
    const Word = Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String })
    const num = G.integer.pipe(
      G.decodeTo(Num)({ decode: (value) => ({ kind: "num", value }), encode: (n) => n.value }),
    )
    const w = word.pipe(
      G.decodeTo(Word)({ decode: (value) => ({ kind: "word", value }), encode: (w) => w.value }),
    )
    const g = G.choice(num, w)
    assert.deepEqual(parseOk(g, "12"), { kind: "num", value: 12 })
    assert.equal(printOk(g, { kind: "word", value: "ab" }), "ab")
    assert.equal(printOk(g, { kind: "num", value: 3 }), "3")
    assertRoundTrip(g, { kind: "word", value: "ab" })
  })

  it("decodeTo rejects on parse when the schema does", () => {
    const Small = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 }))
    const g = G.integer.pipe(
      G.decodeTo(Small)({ decode: (n) => n, encode: (n) => n, name: "digit" }),
    )
    assert.deepEqual(parseFail(g, "10").expected, ["digit"])
  })

  it("decodeTo takes an `is` override in place of the schema guard", () => {
    const Small = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 }))
    const g = G.integer.pipe(
      G.decodeTo(Small)({
        decode: (n) => n,
        encode: (n) => n,
        is: (n) => n % 2 === 0,
        name: "even",
      }),
    )
    assert.equal(parseOk(g, "10"), 10)
    assert.deepEqual(parseFail(g, "3").expected, ["even"])
    assert.match(printFail(g, 3).message, /even/)
  })

  it("a transform over take still recovers the count", () => {
    const g = G.gen(function* () {
      const n = yield* G.integer
      yield* G.literal(":")
      const chars = yield* G.take(n).pipe(
        G.transform({
          decode: (s: string): ReadonlyArray<string> => s.split(""),
          encode: (cs) => cs.join(""),
        }),
      )
      return chars
    })
    assert.deepEqual(parseOk(g, "2:ab"), ["a", "b"])
    assert.equal(printOk(g, ["x", "y", "z"]), "3:xyz")
  })
})

describe("as / flag / skip", () => {
  it("as gives a silent grammar a constant, and prints only for that constant", () => {
    const g = G.choice(G.literal("yes").pipe(G.as(true)), G.literal("no").pipe(G.as(false)))
    assert.equal(parseOk(g, "no"), false)
    assert.equal(printOk(g, true), "yes")
    assert.equal(printOk(g, false), "no")
    assertRoundTrip(g, false)
  })

  it("flag is presence as a boolean", () => {
    const g = G.gen(function* () {
      const neg = yield* G.flag("-")
      const n = yield* G.integer
      return { neg, n }
    })
    assert.deepEqual(parseOk(g, "-1"), { neg: true, n: 1 })
    assert.deepEqual(parseOk(g, "1"), { neg: false, n: 1 })
    assert.equal(printOk(g, { neg: true, n: 2 }), "-2")
    assert.equal(printOk(g, { neg: false, n: 2 }), "2")
  })

  it("skip discards a value and prints the canonical form", () => {
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
  })
})

describe("lexeme / symbol / whitespace", () => {
  const g = G.wrap(G.symbol("["), G.sepBy(G.lexeme(G.integer), G.symbol(",")), G.symbol("]"))

  it("skips trailing whitespace after tokens", () => {
    assert.deepEqual(parseOk(g, "[ 1 ,2,  3 ]"), [1, 2, 3])
  })

  it("prints one canonical space per lexeme", () => {
    assert.equal(printOk(g, [1, 2]), "[ 1 , 2 ] ")
    assertRoundTrip(g, [1, 2])
  })

  it("whitespace is silent, optional, and hidden from render", () => {
    const w = G.wrap(G.whitespace, G.integer, G.whitespace)
    assert.equal(parseOk(w, "  4 "), 4)
    assert.equal(printOk(w, 4), "4")
    assert.equal(G.render(w), "<integer>")
  })
})

describe("label", () => {
  const g = G.gen(function* () {
    const a = yield* G.regex(/[a-z]/, "letter")
    const b = yield* G.regex(/\d/, "digit")
    return { a, b }
  }).pipe(G.label("pair"))

  it("replaces the expected set when failing at its own start", () => {
    assert.deepEqual(parseFail(g, "1").expected, ["pair"])
  })

  it("keeps sibling expectations recorded at the same position", () => {
    const c = G.choice(G.literal("x"), g, G.regex(/\d/, "digit").pipe(G.label("num")))
    assert.deepEqual(parseFail(c, "!").expected, ['"x"', "pair", "num"])
  })

  it("keeps the deeper expectation after consuming input", () => {
    const e = parseFail(g, "ax")
    assert.equal(e.pos, 1)
    assert.deepEqual(e.expected, ["digit"])
  })

  it("is transparent to print", () => {
    assert.equal(printOk(g, { a: "a", b: "1" }), "a1")
  })
})

describe("suspend", () => {
  type Nested = number | ReadonlyArray<Nested>
  const nested: Grammar.Grammar<Nested> = G.suspend(
    () =>
      G.choice(
        G.integer,
        G.wrap("[", G.sepBy(nested, ","), "]").pipe(
          G.transform({
            decode: (a): Nested => a,
            encode: (a): Array<Nested> => {
              if (!Array.isArray(a)) {
                throw new TypeError("expected array")
              }
              return a
            },
            is: Array.isArray,
          }),
        ),
      ),
    "nested",
  )

  it("parses recursion", () => {
    assert.deepEqual(parseOk(nested, "[1,[2,[]],3]"), [1, [2, []], 3])
  })

  it("prints and round-trips", () => {
    assert.equal(printOk(nested, [1, [2]]), "[1,[2]]")
    assertRoundTrip(nested, [1, [2, []], 3])
  })

  it("renders with the name at the recursion point", () => {
    assert.equal(G.render(nested), '(<integer> | "[" (nested ("," nested)*)? "]")')
  })
})

describe("integer", () => {
  it("parses signed integers and rejects unsafe ones", () => {
    assert.equal(parseOk(G.integer, "-42"), -42)
    assert.deepEqual(parseFail(G.integer, "x").expected, ["integer"])
    assert.deepEqual(parseFail(G.integer, "99999999999999999999").expected, ["integer"])
  })

  it("prints and rejects unsafe values", () => {
    assert.equal(printOk(G.integer, 7), "7")
    assert.match(printFail(G.integer, 1.5).message, /integer/)
  })
})

describe("parse", () => {
  it("is strict about trailing input", () => {
    const e = parseFail(G.integer, "12x")
    assert.equal(e.pos, 2)
    assert.deepEqual(e.expected, ["end of input"])
  })

  it("reports the furthest failure, with line and column", () => {
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
  })

  it("returns a Result", () => {
    assert.ok(Result.isSuccess(G.parse(G.integer, "1")))
    assert.ok(Result.isFailure(G.parse(G.integer, "")))
  })
})

describe("render", () => {
  it("shows literals, regexes, named bindings, and repetition", () => {
    const g = G.gen(function* () {
      yield* G.literal("a")
      const n = yield* G.integer
      const xs = yield* G.many(G.regex(/x/, "x"), { min: 1 })
      const o = yield* G.optional(G.literal("!").pipe(G.as(true)))
      return { n, xs, o }
    })
    assert.equal(G.render(g), '"a" n:<integer> xs:(<x>)+ o:("!")?')
  })

  it("names bindings by their path in the return", () => {
    const g = G.gen(function* () {
      const host = yield* word
      yield* G.literal(":")
      const port = yield* G.integer
      return { address: { host }, ports: [port] }
    })
    assert.equal(G.render(g), 'address.host:<word> ":" ports.0:<integer>')
  })

  it("leaves a bare return and a recovered binding unnamed", () => {
    const g = G.gen(function* () {
      yield* G.literal("<")
      const n = yield* G.integer
      yield* G.literal(">")
      return n
    })
    assert.equal(G.render(g), '"<" <integer> ">"')
  })
})

describe("toSchema", () => {
  const pair = G.gen(function* () {
    const name = yield* G.regex(/[a-z]+/, "name")
    yield* G.literal("=")
    const n = yield* G.integer
    return { name, n }
  })
  const Pair = G.toSchema(
    pair,
    Schema.Struct({
      name: Schema.String,
      n: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
    }),
    { identifier: "Pair" },
  )

  it("decodes and encodes", () => {
    assert.deepEqual(Schema.decodeSync(Pair)("a=1"), { name: "a", n: 1 })
    assert.equal(Schema.encodeSync(Pair)({ name: "b", n: 2 }), "b=2")
  })

  it("surfaces parse errors with position", () => {
    const r = Schema.decodeResult(Pair)("a=x")
    assert.ok(Result.isFailure(r))
    if (Result.isFailure(r)) assert.match(r.failure.message, /line 1, column 3: expected integer/)
  })

  it("applies the target's refinements", () => {
    assert.ok(Result.isFailure(Schema.decodeResult(Pair)("a=10")))
  })

  it("fails to encode what the grammar cannot print", () => {
    const r = Schema.encodeUnknownResult(Pair)({ name: "A", n: 1 })
    assert.ok(Result.isFailure(r))
    if (Result.isFailure(r)) assert.match(r.failure.message, /does not match/)
  })

  it("uses the rendered grammar as the description", () => {
    assert.equal(Grammar.render(pair), 'name:<name> "=" n:<integer>')
  })
})
