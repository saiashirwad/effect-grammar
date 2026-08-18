import assert from "node:assert/strict"

import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe } from "vitest"

import * as Grammar from "../src/grammar.ts"
import {
  assertRoundTrip,
  parseFail,
  parseOk,
  parsePrefixOk,
  printFail,
  printOk,
} from "./helpers.ts"

// ---------------------------------------------------------------------------
// literal
// ---------------------------------------------------------------------------

describe("literal", () => {
  const g = Grammar.literal("hello")

  it.effect("parses a matching prefix (strict EOF)", () =>
    Effect.sync(() => {
      assert.equal(parseOk("hello", g), "hello")
    }),
  )

  it.effect("fails with position and expected", () =>
    Effect.sync(() => {
      const e = parseFail("help", g)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, '"hello"')
      assert.equal(e.found, "h")
    }),
  )

  it.effect("fails on empty input", () =>
    Effect.sync(() => {
      const e = parseFail("", g)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, '"hello"')
      assert.equal(e.found, undefined)
    }),
  )

  it.effect("prints the literal value", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, "hello"), "hello")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, "hello")
    }),
  )
})

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

describe("regex", () => {
  const g = Grammar.regex(/[a-z]+/, "word")

  it.effect("parses a match", () =>
    Effect.sync(() => {
      assert.equal(parseOk("abc", g), "abc")
    }),
  )

  it.effect("fails with expected and found", () =>
    Effect.sync(() => {
      const e = parseFail("123", g)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, "word")
      assert.equal(e.found, "1")
    }),
  )

  it.effect("prints a matching string", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, "xyz"), "xyz")
    }),
  )

  it.effect("print rejects a non-matching string", () =>
    Effect.sync(() => {
      const e = printFail(g, "123")
      assert.match(e.message, /does not match word/)
    }),
  )

  it.effect("preserves flags on print", () =>
    Effect.sync(() => {
      const gi = Grammar.regex(/foo/i, "foo")
      assert.equal(parseOk("FOO", gi), "FOO")
      assert.equal(printOk(gi, "FOO"), "FOO")
    }),
  )

  it.effect("reuses a /g RegExp across matches", () =>
    Effect.sync(() => {
      const re = /\d/g
      const pair = Grammar.struct({
        a: Grammar.regex(re, "digit"),
        b: Grammar.regex(re, "digit"),
      })
      assert.deepEqual(parseOk("12", pair), { a: "1", b: "2" })
      assert.equal(parseOk("7", Grammar.regex(re, "digit")), "7")
      assert.equal(parseOk("8", Grammar.regex(re, "digit")), "8")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, "word")
    }),
  )
})

// ---------------------------------------------------------------------------
// struct
// ---------------------------------------------------------------------------

describe("struct", () => {
  const g = Grammar.struct({
    a: Grammar.literal("a"),
    b: Grammar.literal("b"),
  })

  it.effect("parses fields in order", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("ab", g), { a: "a", b: "b" })
    }),
  )

  it.effect("fails at the broken field", () =>
    Effect.sync(() => {
      const e = parseFail("ax", g)
      assert.equal(e.pos, 1)
      assert.equal(e.expected, '"b"')
      assert.equal(e.found, "x")
    }),
  )

  it.effect("prints by concatenating fields", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, { a: "a", b: "b" }), "ab")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, { a: "a" as const, b: "b" as const })
    }),
  )
})

// ---------------------------------------------------------------------------
// choice
// ---------------------------------------------------------------------------

describe("choice", () => {
  const g = Grammar.choice(Grammar.literal("foo"), Grammar.literal("bar"))

  it.effect("parses the first matching option", () =>
    Effect.sync(() => {
      assert.equal(parseOk("foo", g), "foo")
      assert.equal(parseOk("bar", g), "bar")
    }),
  )

  it.effect("fails when no option matches", () =>
    Effect.sync(() => {
      const e = parseFail("baz", g)
      assert.equal(e.pos, 0)
      // furthest among equal positions is last-wins (`pos >=`)
      assert.equal(e.expected, '"bar"')
    }),
  )

  // Bare literals always print successfully, so choice always picks the first.
  // Discriminating print needs regex (or guard) — see also the guard suite.
  it.effect("print picks the first option that can print the value", () =>
    Effect.sync(() => {
      const nums = Grammar.choice(
        Grammar.regex(/[0-9]+/, "digits"),
        Grammar.regex(/[a-z]+/, "letters"),
      )
      assert.equal(printOk(nums, "12"), "12")
      assert.equal(printOk(nums, "ab"), "ab")
    }),
  )

  it.effect("round-trips when options discriminate on print", () =>
    Effect.sync(() => {
      const nums = Grammar.choice(
        Grammar.regex(/[0-9]+/, "digits"),
        Grammar.regex(/[a-z]+/, "letters"),
      )
      assertRoundTrip(nums, "12")
      assertRoundTrip(nums, "ab")
    }),
  )
})

// ---------------------------------------------------------------------------
// many
// ---------------------------------------------------------------------------

describe("many", () => {
  const g = Grammar.many(Grammar.literal("a"))

  it.effect("parses zero or more", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("", g), [])
      assert.deepEqual(parseOk("aaa", g), ["a", "a", "a"])
    }),
  )

  it.effect("atLeast requires a minimum", () =>
    Effect.sync(() => {
      const g1 = Grammar.many(Grammar.literal("a"), { atLeast: 2 })
      assert.deepEqual(parseOk("aa", g1), ["a", "a"])
      const e = parseFail("a", g1)
      assert.equal(e.pos, 1)
      assert.equal(e.expected, '"a"')
    }),
  )

  it.effect("rejects invalid atLeast values", () =>
    Effect.sync(() => {
      for (const atLeast of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => Grammar.many(Grammar.literal("a"), { atLeast }), RangeError)
      }
    }),
  )

  it.effect("prints by concatenating elements", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, ["a", "a"]), "aa")
      assert.equal(printOk(g, []), "")
    }),
  )

  it.effect("print rejects below atLeast", () =>
    Effect.sync(() => {
      const g1 = Grammar.many(Grammar.literal("a"), { atLeast: 2 })
      const e = printFail(g1, [])
      assert.match(e.message, /at least 2 items/)
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, ["a", "a", "a"])
      assertRoundTrip(g, [])
    }),
  )

  it.effect("dies on zero-width success", () =>
    Effect.sync(() => {
      // optional always succeeds without consuming when missing — many would loop forever
      const zeroWidth = Grammar.many(Grammar.optional(Grammar.literal("x")))
      assert.throws(
        () => Effect.runSync(Grammar.parse("", zeroWidth)),
        (err: unknown) =>
          err instanceof Error && err.message.includes("succeeded without consuming input"),
      )
    }),
  )

  it.effect("fails when the inner commits after partial consume", () =>
    Effect.sync(() => {
      const pair = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") })
      const e = parseFail("abac", Grammar.many(pair))
      assert.equal(e.pos, 3)
      assert.equal(e.expected, '"b"')
    }),
  )
})

// ---------------------------------------------------------------------------
// sepBy / sepBy1
// ---------------------------------------------------------------------------

describe("sepBy / sepBy1", () => {
  const item = Grammar.regex(/[a-z]+/, "word")
  const g = Grammar.sepBy(item, Grammar.literal(","))
  const g1 = Grammar.sepBy1(item, Grammar.literal(","))

  it.effect("sepBy accepts empty", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("", g), [])
    }),
  )

  it.effect("sepBy parses lists", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("a,b,c", g), ["a", "b", "c"])
    }),
  )

  it.effect("sepBy1 requires at least one", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("a", g1), ["a"])
      const e = parseFail("", g1)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, "word")
    }),
  )

  it.effect("fails after a separator with no following item (committed)", () =>
    Effect.sync(() => {
      const e = parseFail("a,", g)
      assert.equal(e.pos, 2)
      assert.equal(e.expected, "word")
    }),
  )

  it.effect("prints with separators", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, ["a", "b"]), "a,b")
      assert.equal(printOk(g, []), "")
    }),
  )

  it.effect("print rejects sepBy1 below atLeast", () =>
    Effect.sync(() => {
      const e = printFail(g1, [])
      assert.match(e.message, /at least 1 items/)
    }),
  )

  it.effect("dies on zero-width separator+element", () =>
    Effect.sync(() => {
      assert.throws(
        () => Effect.runSync(Grammar.parse("", Grammar.sepBy(Grammar.end, Grammar.end))),
        (err: unknown) =>
          err instanceof Error && err.message.includes("succeeded without consuming input"),
      )
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, ["one", "two"])
      assertRoundTrip(g, [])
      assertRoundTrip(g1, ["only"])
    }),
  )
})

// ---------------------------------------------------------------------------
// optional
// ---------------------------------------------------------------------------

describe("optional", () => {
  const g = Grammar.struct({
    a: Grammar.optional(Grammar.literal("a")),
    b: Grammar.literal("b"),
  })

  it.effect("parses present and missing", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("ab", g), { a: "a", b: "b" })
      assert.deepEqual(parseOk("b", g), { a: undefined, b: "b" })
    }),
  )

  it.effect("propagates committed failures from the inner parser", () =>
    Effect.sync(() => {
      // optional does not swallow a failure after the inner has consumed input
      const committed = Grammar.struct({
        head: Grammar.optional(
          Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") }),
        ),
        tail: Grammar.literal("x"),
      })
      const e = parseFail("ax", committed)
      assert.equal(e.pos, 1)
      assert.equal(e.expected, '"b"')
    }),
  )

  it.effect("prints undefined as empty", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, { a: undefined, b: "b" }), "b")
      assert.equal(printOk(g, { a: "a", b: "b" }), "ab")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, { a: "a" as const, b: "b" as const })
      assertRoundTrip(g, { a: undefined, b: "b" as const })
    }),
  )
})

// ---------------------------------------------------------------------------
// attempt
// ---------------------------------------------------------------------------

describe("attempt", () => {
  // Without attempt: "tr" + "ue" commits on "tr", so "truce" fails at "e"
  const trueKw = Grammar.struct({
    t: Grammar.literal("tr"),
    rest: Grammar.literal("ue"),
  })
  const ident = Grammar.regex(/[a-z]+/, "ident")

  it.effect("without attempt, choice commits after consume", () =>
    Effect.sync(() => {
      const g = Grammar.choice(trueKw, ident)
      const e = parseFail("truce", g)
      assert.equal(e.pos, 2)
      assert.equal(e.expected, '"ue"')
    }),
  )

  it.effect("with attempt, rewinds so choice tries next option", () =>
    Effect.sync(() => {
      const g = Grammar.choice(Grammar.attempt(trueKw), ident)
      assert.equal(parseOk("truce", g), "truce")
      assert.deepEqual(parseOk("true", g), { t: "tr", rest: "ue" })
    }),
  )

  it.effect("prints through to the inner grammar", () =>
    Effect.sync(() => {
      const g = Grammar.attempt(Grammar.literal("x"))
      assert.equal(printOk(g, "x"), "x")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(Grammar.attempt(Grammar.literal("ok")), "ok")
    }),
  )
})

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe("count", () => {
  const g = Grammar.count(Grammar.literal("x"), 3)

  it.effect("parses exactly n times", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("xxx", g), ["x", "x", "x"])
    }),
  )

  it.effect("fails if fewer than n", () =>
    Effect.sync(() => {
      const e = parseFail("xx", g)
      assert.equal(e.pos, 2)
      assert.equal(e.expected, '"x"')
    }),
  )

  it.effect("print rejects wrong length", () =>
    Effect.sync(() => {
      const e = printFail(g, ["x", "x"])
      assert.match(e.message, /exactly 3 items/)
    }),
  )

  it.effect("prints and round-trips", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, ["x", "x", "x"]), "xxx")
      assertRoundTrip(g, ["x", "x", "x"])
    }),
  )
})

// ---------------------------------------------------------------------------
// between
// ---------------------------------------------------------------------------

describe("between", () => {
  const g = Grammar.between(
    Grammar.label("'('", Grammar.literal("(")),
    Grammar.label("')'", Grammar.literal(")")),
    Grammar.integer,
  )

  it.effect("parses open, inner, close", () =>
    Effect.sync(() => {
      assert.equal(parseOk("(42)", g), 42)
    }),
  )

  it.effect("fails on missing close with the delimiter label", () =>
    Effect.sync(() => {
      const e = parseFail("(42", g)
      assert.equal(e.pos, 3)
      assert.equal(e.expected, "')'")
    }),
  )

  it.effect("prints delimiters around the value", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, 7), "(7)")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, 99)
    }),
  )
})

// ---------------------------------------------------------------------------
// integer
// ---------------------------------------------------------------------------

describe("integer", () => {
  it.effect("parses signed integers", () =>
    Effect.sync(() => {
      assert.equal(parseOk("42", Grammar.integer), 42)
      assert.equal(parseOk("-7", Grammar.integer), -7)
    }),
  )

  it.effect("fails on non-digits", () =>
    Effect.sync(() => {
      const e = parseFail("x", Grammar.integer)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, "integer")
    }),
  )

  it.effect("prints and round-trips", () =>
    Effect.sync(() => {
      assert.equal(printOk(Grammar.integer, 42), "42")
      assertRoundTrip(Grammar.integer, -3)
    }),
  )

  it.effect("rejects unsafe integers", () =>
    Effect.sync(() => {
      const e = parseFail("9007199254740992", Grammar.integer)
      assert.equal(e.expected, "integer")
    }),
  )
})

// ---------------------------------------------------------------------------
// lexeme / symbol
// ---------------------------------------------------------------------------

describe("lexeme / symbol", () => {
  const g = Grammar.struct({
    a: Grammar.symbol("let"),
    name: Grammar.lexeme(Grammar.regex(/[a-z]+/, "name")),
  })

  it.effect("skips trailing whitespace after tokens", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("let  foo", g), { a: "let", name: "foo" })
      assert.deepEqual(parseOk("let foo", g), { a: "let", name: "foo" })
    }),
  )

  it.effect("fails with the inner expected", () =>
    Effect.sync(() => {
      const e = parseFail("var x", g)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, '"let"')
    }),
  )

  it.effect("print emits a canonical trailing space from lexeme", () =>
    Effect.sync(() => {
      // lexeme from maps ws → " "
      const printed = printOk(g, { a: "let", name: "foo" })
      assert.equal(printed, "let foo ")
    }),
  )

  it.effect("round-trips (print normalizes whitespace)", () =>
    Effect.sync(() => {
      const value = { a: "let" as const, name: "foo" }
      const printed = printOk(g, value)
      assert.deepEqual(parseOk(printed, g), value)
    }),
  )
})

// ---------------------------------------------------------------------------
// lazy
// ---------------------------------------------------------------------------

describe("lazy", () => {
  type Nest = { readonly n: number; readonly inner?: Nest }

  const nest: Grammar.Grammar<Nest> = Grammar.lazy(
    () =>
      Grammar.map(
        Grammar.struct({
          open: Grammar.literal("("),
          n: Grammar.integer,
          rest: Grammar.optional(
            Grammar.struct({
              comma: Grammar.literal(","),
              inner: nest,
            }),
          ),
          close: Grammar.literal(")"),
        }),
        {
          to: ({ n, rest }) => (rest === undefined ? { n } : { n, inner: rest.inner }),
          from: ({ n, inner }) => ({
            open: "(" as const,
            n,
            rest: inner === undefined ? undefined : { comma: "," as const, inner },
            close: ")" as const,
          }),
        },
      ),
    { name: "nest" },
  )

  it.effect("parses recursive nesting", () =>
    Effect.sync(() => {
      assert.deepEqual(parseOk("(1,(2,(3)))", nest), {
        n: 1,
        inner: { n: 2, inner: { n: 3 } },
      })
    }),
  )

  it.effect("render terminates on cycles", () =>
    Effect.sync(() => {
      const s = Grammar.render(nest)
      assert.ok(s.includes("nest"), `render should mention the cycle name, got: ${s}`)
      // must finish (no infinite loop) and stay finite
      assert.ok(s.length < 500)
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(nest, { n: 1, inner: { n: 2 } })
    }),
  )
})

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

describe("bind", () => {
  const exactly = (n: number): Grammar.Grammar<string> =>
    Grammar.map(Grammar.count(Grammar.regex(/[\s\S]/, "char"), n), {
      to: (chars) => chars.join(""),
      from: (s: string) => s.split(""),
    })

  const lengthPrefix = Grammar.map(
    Grammar.struct({ n: Grammar.integer, colon: Grammar.literal(":") }),
    {
      to: ({ n }) => n,
      from: (n: number) => ({ n, colon: ":" as const }),
    },
  )

  const netish = Grammar.bind(lengthPrefix, {
    to: exactly,
    from: (s: string) => s.length,
  })

  it.effect("dependent parse uses the bound value", () =>
    Effect.sync(() => {
      assert.equal(parseOk("3:abc", netish), "abc")
    }),
  )

  it.effect("fails when the payload is too short", () =>
    Effect.sync(() => {
      const e = parseFail("3:ab", netish)
      assert.equal(e.pos, 4)
      assert.equal(e.expected, "char")
    }),
  )

  it.effect("turns an invalid dependent count into a parse failure", () =>
    Effect.sync(() => {
      const e = parseFail("-1:x", netish)
      assert.equal(e.expected, "count")
    }),
  )

  it.effect("prints with from", () =>
    Effect.sync(() => {
      assert.equal(printOk(netish, "hi"), "2:hi")
    }),
  )

  it.effect("print fails honestly without from", () =>
    Effect.sync(() => {
      const parseOnly = Grammar.bind(lengthPrefix, { to: exactly })
      const e = printFail(parseOnly, "abc")
      assert.match(e.message, /missing `from`/)
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(netish, "hello")
    }),
  )
})

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

describe("guard", () => {
  const num = Grammar.guard(
    Grammar.map(Grammar.regex(/\d+/, "digits"), { to: Number, from: String }),
    (v) => typeof v === "number",
  )
  const word = Grammar.guard(Grammar.regex(/[a-z]+/, "word"), (v) => typeof v === "string")
  const g = Grammar.choice(num, word)

  it.effect("parse is unaffected by the predicate", () =>
    Effect.sync(() => {
      assert.equal(parseOk("42", g), 42)
      assert.equal(parseOk("hi", g), "hi")
    }),
  )

  it.effect("print rejects values that fail the guard", () =>
    Effect.sync(() => {
      const e = printFail(num, "not-a-number" as unknown as number)
      assert.match(e.message, /rejected by guard/)
    }),
  )

  it.effect("choice skips guarded options when printing", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, 9), "9")
      assert.equal(printOk(g, "ok"), "ok")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, 12)
      assertRoundTrip(g, "ab")
    }),
  )
})

// ---------------------------------------------------------------------------
// mapSchema
// ---------------------------------------------------------------------------

describe("mapSchema", () => {
  const num = Grammar.mapSchema(Grammar.regex(/\d+/, "digits"), Schema.Finite, {
    to: Number,
    from: String,
  })
  const word = Grammar.mapSchema(Grammar.regex(/[a-z]+/, "word"), Schema.String, {
    to: (s) => s,
    from: (s) => s,
  })
  const g = Grammar.choice(num, word)

  it.effect("parse is unaffected by the schema", () =>
    Effect.sync(() => {
      assert.equal(parseOk("42", g), 42)
      assert.equal(parseOk("hi", g), "hi")
    }),
  )

  it.effect("print rejects values the schema rejects", () =>
    Effect.sync(() => {
      const e = printFail(num, Number.NaN)
      assert.match(e.message, /rejected by guard/)
    }),
  )

  it.effect("choice skips options whose schema rejects the value", () =>
    Effect.sync(() => {
      assert.equal(printOk(g, 9), "9")
      assert.equal(printOk(g, "ok"), "ok")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(g, 12)
      assertRoundTrip(g, "ab")
    }),
  )

  it.effect("supports recursive schemas via lazy guard compilation", () =>
    Effect.sync(() => {
      type Tree = { readonly value: number; readonly children: ReadonlyArray<Tree> }
      const TreeSchema: Schema.Codec<Tree> = Schema.Struct({
        value: Schema.Finite,
        children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => TreeSchema)),
      })
      // Defined before the const below finishes initializing — must not throw.
      const tree: Grammar.Grammar<Tree> = Grammar.mapSchema(
        Grammar.struct({
          value: Grammar.integer,
          children: Grammar.between(
            Grammar.symbol("("),
            Grammar.symbol(")"),
            Grammar.sepBy(
              Grammar.lazy(() => tree),
              Grammar.symbol(","),
            ),
          ),
        }),
        TreeSchema,
        {
          to: ({ value, children }): Tree => ({ value, children }),
          from: (t) => ({ value: t.value, children: [...t.children] }),
        },
      )
      const value: Tree = { value: 1, children: [{ value: 2, children: [] }] }
      assertRoundTrip(tree, value)
    }),
  )
})

// ---------------------------------------------------------------------------
// fromEffect
// ---------------------------------------------------------------------------

describe("fromEffect", () => {
  it.effect("parses via the opaque effect", () =>
    Effect.sync(() => {
      const g = Grammar.fromEffect(Effect.succeed("hardcoded"), "fx")
      assert.equal(parsePrefixOk("anything", g), "hardcoded")
    }),
  )

  it.effect("print fails with PrintError so choice can try the next option", () =>
    Effect.sync(() => {
      const g = Grammar.choice(Grammar.fromEffect(Effect.succeed("x"), "fx"), Grammar.literal("y"))
      assert.equal(printOk(g, "y"), "y")
      const e = printFail(Grammar.fromEffect(Effect.succeed("x"), "fx"), "x")
      assert.match(e.message, /effect-only fragment/)
    }),
  )
})

// ---------------------------------------------------------------------------
// backtracking semantics
// ---------------------------------------------------------------------------

describe("backtracking semantics", () => {
  it.effect("choice commits after consuming input", () =>
    Effect.sync(() => {
      const ab = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") })
      const ac = Grammar.struct({ a: Grammar.literal("a"), c: Grammar.literal("c") })
      const g = Grammar.choice(ab, ac)
      // first option consumes "a", fails on "c" vs "b" — second option is not tried
      const e = parseFail("ac", g)
      assert.equal(e.pos, 1)
      assert.equal(e.expected, '"b"')
    }),
  )

  it.effect("attempt rewinds so choice can try the next option", () =>
    Effect.sync(() => {
      const ab = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") })
      const ac = Grammar.struct({ a: Grammar.literal("a"), c: Grammar.literal("c") })
      const g = Grammar.choice(Grammar.attempt(ab), ac)
      assert.deepEqual(parseOk("ac", g), { a: "a", c: "c" })
    }),
  )

  it.effect("many dies on zero-width success", () =>
    Effect.sync(() => {
      assert.throws(() => Effect.runSync(Grammar.parse("x", Grammar.many(Grammar.end))))
    }),
  )
})

// ---------------------------------------------------------------------------
// strict EOF
// ---------------------------------------------------------------------------

describe("strict EOF", () => {
  const g = Grammar.literal("hi")

  it.effect("parse rejects trailing garbage", () =>
    Effect.sync(() => {
      const e = parseFail("hi!", g)
      assert.equal(e.pos, 2)
      assert.equal(e.expected, "end of input")
      assert.equal(e.found, "!")
    }),
  )

  it.effect("parsePrefix allows trailing input", () =>
    Effect.sync(() => {
      assert.equal(parsePrefixOk("hi!", g), "hi")
    }),
  )
})

// ---------------------------------------------------------------------------
// toSchema
// ---------------------------------------------------------------------------

describe("toSchema", () => {
  const g = Grammar.integer
  const S = Grammar.toSchema(g, Schema.Finite, { identifier: "Int" })

  it.effect("derived schema decodes and encodes", () =>
    Effect.sync(() => {
      const decoded = Effect.runSync(Schema.decodeUnknownEffect(S)("42"))
      assert.equal(decoded, 42)
      const encoded = Effect.runSync(Schema.encodeEffect(S)(42))
      assert.equal(encoded, "42")
    }),
  )

  it.effect("strict EOF applies through the schema", () =>
    Effect.sync(() => {
      const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(S)("42x")))
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.match(String(r.failure), /end of input/)
      }
    }),
  )

  it.effect("refinement errors surface when the target rejects", () =>
    Effect.sync(() => {
      const Positive = Grammar.toSchema(g, Schema.Finite.check(Schema.isGreaterThan(0)))
      const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Positive)("0")))
      assert.equal(r._tag, "Failure")
    }),
  )

  it.effect("encode fails when print fails", () =>
    Effect.sync(() => {
      const word = Grammar.toSchema(Grammar.regex(/[a-z]+/, "word"), Schema.String)
      const r = Effect.runSync(Effect.result(Schema.encodeEffect(word)("123")))
      assert.equal(r._tag, "Failure")
    }),
  )
})

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------

describe("label", () => {
  it.effect("replaces expected when the inner fails without consuming", () =>
    Effect.sync(() => {
      const g = Grammar.label("port", Grammar.regex(/\d+/, "digits"))
      const e = parseFail("#", g)
      assert.equal(e.pos, 0)
      assert.equal(e.expected, "port")
      assert.equal(e.found, "#")
    }),
  )

  it.effect("propagates the inner expected after consuming input", () =>
    Effect.sync(() => {
      const g = Grammar.label(
        "ab",
        Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") }),
      )
      const e = parseFail("ax", g)
      assert.equal(e.pos, 1)
      assert.equal(e.expected, '"b"')
      assert.equal(e.found, "x")
    }),
  )

  it.effect("print is transparent", () =>
    Effect.sync(() => {
      const g = Grammar.label("word", Grammar.regex(/[a-z]+/, "word"))
      assert.equal(printOk(g, "hi"), "hi")
    }),
  )

  it.effect("round-trips", () =>
    Effect.sync(() => {
      assertRoundTrip(Grammar.label("n", Grammar.integer), 7)
    }),
  )

  it.effect("render shows <label> for a raw regex, otherwise the inner", () =>
    Effect.sync(() => {
      assert.equal(Grammar.render(Grammar.label("port", Grammar.regex(/\d+/, "digits"))), "<port>")
      assert.equal(Grammar.render(Grammar.label("hi", Grammar.literal("hi"))), '"hi"')
    }),
  )
})

// ---------------------------------------------------------------------------
// line / column messages
// ---------------------------------------------------------------------------

describe("line / column messages", () => {
  it.effect("attaches 1-based line and column at the parse boundary", () =>
    Effect.sync(() => {
      const g = Grammar.struct({
        a: Grammar.literal("aa"),
        nl: Grammar.literal("\n"),
        b: Grammar.literal("bb"),
      })
      const e = parseFail("aa\nx", g)
      assert.equal(e.pos, 3)
      assert.equal(e.line, 2)
      assert.equal(e.column, 1)
      assert.equal(e.expected, '"bb"')
      assert.equal(e.message, 'line 2, column 1: expected "bb", found "x"')
    }),
  )

  it.effect("uses column = pos + 1 on a single line", () =>
    Effect.sync(() => {
      const e = parseFail("hello!", Grammar.literal("hello"))
      assert.equal(e.pos, 5)
      assert.equal(e.line, 1)
      assert.equal(e.column, 6)
      assert.match(e.message, /^line 1, column 6: expected end of input, found "!"$/)
    }),
  )

  it.effect("surfaces in toSchema decode errors", () =>
    Effect.sync(() => {
      const S = Grammar.toSchema(
        Grammar.label("port", Grammar.regex(/\d+/, "digits")),
        Schema.String,
      )
      const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(S)("#")))
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.match(String(r.failure), /line 1, column 1: expected port, found "#"/)
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

describe("render", () => {
  it.effect("renders literals, regexes, and combinators", () =>
    Effect.sync(() => {
      assert.equal(Grammar.render(Grammar.literal("hi")), '"hi"')
      assert.equal(Grammar.render(Grammar.regex(/\d+/, "digits")), "/\\d+/")
      assert.equal(Grammar.render(Grammar.regex(/abc/is, "abc")), "/abc/is")
      assert.equal(
        Grammar.render(Grammar.choice(Grammar.literal("a"), Grammar.literal("b"))),
        '"a" | "b"',
      )
      assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"))), '("x")*')
      assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"), { atLeast: 1 })), '("x")+')
      assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"), { atLeast: 2 })), '("x"){2,}')
      assert.equal(Grammar.render(Grammar.optional(Grammar.literal("x"))), '("x")?')
      assert.equal(Grammar.render(Grammar.count(Grammar.literal("x"), 2)), '("x"){2}')
      assert.equal(Grammar.render(Grammar.end), "<end>")
      assert.equal(Grammar.render(Grammar.attempt(Grammar.literal("x"))), 'attempt("x")')
    }),
  )

  it.effect("renders struct fields", () =>
    Effect.sync(() => {
      const s = Grammar.render(Grammar.struct({ a: Grammar.literal("a"), b: Grammar.integer }))
      assert.equal(s, 'a: "a" b: <integer>')
    }),
  )

  it.effect("renders sepBy", () =>
    Effect.sync(() => {
      const s = Grammar.render(Grammar.sepBy(Grammar.literal("a"), Grammar.literal(",")))
      assert.equal(s, '("a" ("," "a")*)?')
      assert.equal(
        Grammar.render(Grammar.sepBy1(Grammar.literal("a"), Grammar.literal(","))),
        '"a" ("," "a")*',
      )
    }),
  )

  it.effect("renders bind", () =>
    Effect.sync(() => {
      const s = Grammar.render(Grammar.bind(Grammar.integer, { to: () => Grammar.literal("x") }))
      assert.equal(s, "<integer> >>= <bind>")
    }),
  )
})

// ---------------------------------------------------------------------------
// checkRoundTrip
// ---------------------------------------------------------------------------

describe("checkRoundTrip", () => {
  it.effect("succeeds when print ∘ parse recovers the value", () =>
    Effect.sync(() => {
      Effect.runSync(Grammar.checkRoundTrip(Grammar.integer, 42))
      Effect.runSync(
        Grammar.checkRoundTrip(Grammar.struct({ a: Grammar.literal("a"), n: Grammar.integer }), {
          a: "a",
          n: 7,
        }),
      )
    }),
  )

  it.effect("fails at stage print when the value cannot be printed", () =>
    Effect.sync(() => {
      // bind without `from` — print is honest and refuses
      const g = Grammar.bind(Grammar.integer, { to: () => Grammar.literal("x") })
      const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, "x")))
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.ok(Schema.is(Grammar.RoundTripError)(r.failure))
        assert.equal(r.failure.stage, "print")
        assert.match(r.failure.message, /print failed/)
      }
    }),
  )

  it.effect("fails at stage print when many atLeast is not met", () =>
    Effect.sync(() => {
      const g = Grammar.many(Grammar.literal("a"), { atLeast: 2 })
      const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, [])))
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.ok(Schema.is(Grammar.RoundTripError)(r.failure))
        assert.equal(r.failure.stage, "print")
        assert.match(r.failure.message, /print failed/)
      }
    }),
  )

  it.effect("fails at stage parse when the printed string does not re-parse", () =>
    Effect.sync(() => {
      // `end` between tokens prints as "" so the string is "ab", but re-parse hits
      // end while input remains.
      const g = Grammar.struct({
        a: Grammar.literal("a"),
        e: Grammar.end,
        b: Grammar.literal("b"),
      })
      const r = Effect.runSync(
        Effect.result(Grammar.checkRoundTrip(g, { a: "a", e: undefined, b: "b" })),
      )
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.ok(Schema.is(Grammar.RoundTripError)(r.failure))
        assert.equal(r.failure.stage, "parse")
        assert.match(r.failure.message, /re-parse failed/)
      }
    }),
  )

  it.effect("fails at stage equal when re-parse yields a different value", () =>
    Effect.sync(() => {
      // print always emits "0"; parse turns that into 0 — original was 1
      const g = Grammar.map(Grammar.regex(/\d+/, "digits"), {
        to: Number,
        from: () => "0",
      })
      const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, 1)))
      assert.equal(r._tag, "Failure")
      if (r._tag === "Failure") {
        assert.ok(Schema.is(Grammar.RoundTripError)(r.failure))
        assert.equal(r.failure.stage, "equal")
        assert.match(r.failure.message, /value mismatch/)
        assert.match(r.failure.message, /original/)
        assert.match(r.failure.message, /reparsed/)
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// deep recursion (stack safety)
// ---------------------------------------------------------------------------

describe("deep recursion", () => {
  const depth = 1000
  const deep = "[".repeat(depth) + "1" + "]".repeat(depth)

  const nested: Grammar.Grammar<unknown> = Grammar.lazy(() =>
    Grammar.choice(
      Grammar.map(Grammar.regex(/\d+/, "digits"), { to: Number, from: String }),
      Grammar.between(
        Grammar.symbol("["),
        Grammar.symbol("]"),
        Grammar.sepBy(nested, Grammar.symbol(",")),
      ),
    ),
  )

  it.effect("parses without blowing the stack", () =>
    Effect.sync(() => {
      // Walk the result iteratively — structural deepEqual recurses and would
      // blow the stack all by itself.
      let v: unknown = parseOk(deep, nested)
      let d = 0
      while (Array.isArray(v)) {
        v = v[0]
        d++
      }
      assert.equal(d, depth)
      assert.equal(v, 1)
    }),
  )

  it.effect("prints and re-parses without blowing the stack", () =>
    Effect.sync(() => {
      // Same story for equality: compare print fixpoints, not nested values.
      const printed = printOk(nested, parseOk(deep, nested))
      assert.equal(printed, printOk(nested, parseOk(printed, nested)))
    }),
  )
})
