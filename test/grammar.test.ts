import assert from "node:assert/strict"

import { Result, Schema } from "effect"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const G = Grammar

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
  const g = G.regex(/[a-z]+/, "word")

  it("parses a match anchored at the cursor", () => {
    assert.equal(parseOk(g, "abc"), "abc")
    assert.deepEqual(parseFail(g, "1abc").expected, ["word"])
  })

  it("prints a matching string and rejects a non-matching one", () => {
    assert.equal(printOk(g, "xyz"), "xyz")
    assert.match(printFail(g, "x1").message, /does not match/)
    assert.match(printFail(g, 42 as unknown as string).message, /expected a string/)
  })

  it("ignores g and y flags", () => {
    const sticky = G.regex(/\d/gy, "digit")
    assert.deepEqual(parseOk(G.many(sticky), "123"), ["1", "2", "3"])
  })

  it("round-trips", () => {
    assertRoundTrip(g, "roundtrip")
  })
})

describe("seq", () => {
  const g = G.seq(G.field("a", G.regex(/[a-z]+/, "word")), G.literal("-"), G.field("n", G.integer))

  it("parses in order and yields the object of fields", () => {
    assert.deepEqual(parseOk(g, "ab-12"), { a: "ab", n: 12 })
  })

  it("fails at the broken part", () => {
    const e = parseFail(g, "ab-x")
    assert.equal(e.pos, 3)
    assert.deepEqual(e.expected, ["integer"])
  })

  it("prints each field from the object and silent parts from themselves", () => {
    assert.equal(printOk(g, { a: "zz", n: -3 }), "zz--3")
    assertRoundTrip(g, { a: "zz", n: -3 })
  })

  it("is silent when every part is silent", () => {
    const s = G.seq(G.literal("a"), G.literal("b"))
    assert.equal(parseOk(s, "ab"), undefined)
    assert.equal(printOk(s, undefined), "ab")
    // Silent, so it can be yielded bare:
    const outer = G.gen(function* () {
      yield* s
      const n = yield* G.field("n", G.integer)
      return { n }
    })
    assert.deepEqual(parseOk(outer, "ab1"), { n: 1 })
  })
})

describe("gen", () => {
  const endpoint = G.gen(function* () {
    yield* G.literal("https://")
    const host = yield* G.field("host", G.regex(/[^:/]+/, "host"))
    const port = yield* G.field("port", G.optional(G.prefix(":", G.integer)))
    return { host, port: port ?? 443 }
  })

  it("parses a sequence with the generator's return as the value", () => {
    assert.deepEqual(parseOk(endpoint, "https://x:8080"), { host: "x", port: 8080 })
    assert.deepEqual(parseOk(endpoint, "https://x"), { host: "x", port: 443 })
  })

  it("prints by replaying the generator with the value's fields", () => {
    assert.equal(printOk(endpoint, { host: "x", port: 443 }), "https://x:443")
    assertRoundTrip(endpoint, { host: "x", port: 443 })
  })

  it("yields the object of fields when there is no return", () => {
    const g = G.gen(function* () {
      yield* G.literal("(")
      yield* G.field("n", G.integer)
      yield* G.literal(")")
    })
    assert.deepEqual(parseOk(g, "(7)"), { n: 7 })
    assert.equal(printOk(g, { n: 7 }), "(7)")
  })

  it("follows control flow on parsed values in both directions", () => {
    const g = G.gen(function* () {
      const kind = yield* G.field(
        "kind",
        G.choice(G.literal("n:").pipe(G.as("num")), G.literal("w:").pipe(G.as("word"))),
      )
      const value = yield* G.field("value", kind === "num" ? G.integer : G.regex(/[a-z]+/, "word"))
      return { kind, value }
    })
    assert.deepEqual(parseOk(g, "n:12"), { kind: "num", value: 12 })
    assert.deepEqual(parseOk(g, "w:ab"), { kind: "word", value: "ab" })
    assert.equal(printOk(g, { kind: "word", value: "zz" }), "w:zz")
    assert.equal(printOk(g, { kind: "num", value: 5 }), "n:5")
    assert.match(printFail(g, { kind: "num", value: "zz" as never }).message, /integer/)
  })

  it("rejects a field yielded twice", () => {
    const g = G.gen(function* () {
      yield* G.field("n", G.integer)
      yield* G.literal(",")
      yield* G.field("n", G.integer)
    })
    assert.throws(() => G.parse(g, "1,2"), /yielded twice/)
  })

  it("reports the failing part's position", () => {
    const e = parseFail(endpoint, "https://x:abc")
    assert.equal(e.pos, 10)
    assert.deepEqual(e.expected, ["integer"])
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
    const outer = G.seq(s, G.field("n", G.integer))
    assert.deepEqual(parseOk(outer, "<x>1"), { n: 1 })
    assert.equal(printOk(outer, { n: 1 }), "<x>1")
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
    const e = printFail(g, "zz" as never)
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
  const g = G.seq(
    G.field("sign", G.optional(G.literal("-").pipe(G.as(true)))),
    G.field("n", G.integer),
  )

  it("parses present and absent", () => {
    assert.deepEqual(parseOk(g, "-4"), { sign: true, n: 4 })
    assert.deepEqual(parseOk(g, "4"), { sign: undefined, n: 4 })
  })

  it("prints undefined as nothing", () => {
    assert.equal(printOk(g, { sign: undefined, n: 4 }), "4")
    assert.equal(printOk(g, { sign: true, n: 4 }), "-4")
  })

  it("is silent when the inner is silent, and prints nothing", () => {
    const trailing = G.seq(G.field("n", G.integer), G.optional(G.literal(",")))
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
        is: (u) => typeof u === "number" && u % 2 === 0,
        name: "even",
      }),
    )
    assert.equal(parseOk(even, "4"), 4)
    assert.deepEqual(parseFail(even, "3").expected, ["even"])
    assert.match(printFail(even, 3).message, /even/)
  })

  it("decodeTo uses the schema as the guard, so choice can pick a branch when printing", () => {
    const Num = Schema.Struct({ kind: Schema.Literal("num"), value: Schema.Finite })
    const Word = Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String })
    const num = G.integer.pipe(
      G.decodeTo(Num)({ decode: (value) => ({ kind: "num", value }), encode: (n) => n.value }),
    )
    const word = G.regex(/[a-z]+/, "word").pipe(
      G.decodeTo(Word)({ decode: (value) => ({ kind: "word", value }), encode: (w) => w.value }),
    )
    const g = G.choice(num, word)
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
    const g = G.seq(G.field("neg", G.flag("-")), G.field("n", G.integer))
    assert.deepEqual(parseOk(g, "-1"), { neg: true, n: 1 })
    assert.deepEqual(parseOk(g, "1"), { neg: false, n: 1 })
    assert.equal(printOk(g, { neg: true, n: 2 }), "-2")
    assert.equal(printOk(g, { neg: false, n: 2 }), "2")
  })

  it("skip discards a value and prints the canonical form", () => {
    const ws = G.regex(/\s+/, "space").pipe(G.skip(" "))
    const g = G.seq(G.field("a", G.integer), ws, G.field("b", G.integer))
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
  const g = G.seq(
    G.field("a", G.regex(/[a-z]/, "letter")),
    G.field("b", G.regex(/\d/, "digit")),
  ).pipe(G.label("pair"))

  it("replaces the expected set when failing at its own start", () => {
    assert.deepEqual(parseFail(g, "1").expected, ["pair"])
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
            encode: (a) => a as Array<Nested>,
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
    const g = G.seq(G.field("a", G.integer), G.literal("\n"), G.field("b", G.integer))
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
  it("shows literals, regexes, fields, and repetition", () => {
    const g = G.seq(
      G.literal("a"),
      G.field("n", G.integer),
      G.field("xs", G.many(G.regex(/x/, "x"), { min: 1 })),
      G.field("o", G.optional(G.literal("!").pipe(G.as(true)))),
    )
    assert.equal(G.render(g), '"a" n:<integer> xs:(<x>)+ o:("!")?')
  })

  it("dry-runs gen", () => {
    const g = G.gen(function* () {
      yield* G.literal("<")
      const n = yield* G.field("n", G.integer)
      yield* G.literal(">")
      return { n }
    })
    assert.equal(G.render(g), '"<" n:<integer> ">"')
  })
})

describe("toSchema", () => {
  const pair = G.seq(
    G.field("name", G.regex(/[a-z]+/, "name")),
    G.literal("="),
    G.field("n", G.integer),
  )
  const Pair = G.toSchema(
    pair,
    Schema.Struct({
      name: Schema.String,
      n: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
    }),
    { identifier: "Pair" },
  )

  it("decodes and encodes", () => {
    assert.deepEqual(Schema.decodeUnknownSync(Pair)("a=1"), { name: "a", n: 1 })
    assert.equal(Schema.encodeSync(Pair)({ name: "b", n: 2 }), "b=2")
  })

  it("surfaces parse errors with position", () => {
    const r = Schema.decodeUnknownResult(Pair)("a=x")
    assert.ok(Result.isFailure(r))
    if (Result.isFailure(r)) assert.match(r.failure.message, /line 1, column 3: expected integer/)
  })

  it("applies the target's refinements", () => {
    assert.ok(Result.isFailure(Schema.decodeUnknownResult(Pair)("a=10")))
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
