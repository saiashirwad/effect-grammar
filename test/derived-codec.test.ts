import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaIssue } from "effect"

import * as Binary from "../src/binary.ts"
import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const format = SchemaIssue.makeFormatterStandardSchemaV1()

const failure = <A>(effect: Effect.Effect<A, Schema.SchemaError>) =>
  Effect.map(Effect.flip(effect), (error) => format(error.issue).issues)

type Tree = number | ReadonlyArray<Tree>

describe("codec(grammar) structure", () => {
  it.effect("derives structs with keyed paths, required keys, and checked printing of excess keys", () =>
    Effect.gen(function*() {
      const point = GrammarSchema.codec(G.struct({ x: G.integer, y: G.integer.pipe(G.prefix(",")) }))

      assert.deepEqual(yield* Schema.decodeEffect(point)("1,2"), { x: 1, y: 2 })
      assert.equal(yield* Schema.encodeUnknownEffect(point)({ x: 1, y: 2 }), "1,2")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(point)({ x: 1.5, y: 2 })), [{
        path: ["x"],
        message: "Expected an integer",
      }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(point)({ x: 1 })), [{
        path: ["y"],
        message: "Missing key",
      }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(point)({ x: 1, y: 2, z: 3 })), [
        { path: [], message: "exactly the fields x, y: unexpected own field" },
      ])
      assert.deepEqual(yield* failure(Schema.decodeEffect(point)("1,")), [
        { path: [], message: "line 1, column 3: expected integer, found end of input" },
      ])
    }))

  it.effect("derives gen layouts with constants, tuples, and required undefined-valued fields", () =>
    Effect.gen(function*() {
      const host = GrammarSchema.codec(G.gen(function*() {
        const name = yield* G.regex(/[a-z]+/, "name")
        const port = yield* G.optional(G.integer.pipe(G.prefix(":")))
        return { kind: "host", name, port, pair: [1, null] }
      }))
      const value = { kind: "host", name: "a", port: undefined, pair: [1, null] }

      assert.deepEqual(yield* Schema.decodeEffect(host)("abc:80"), {
        kind: "host",
        name: "abc",
        port: 80,
        pair: [1, null],
      })
      assert.equal(yield* Schema.encodeUnknownEffect(host)(value), "a")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(host)({ kind: "host", name: "a", pair: [1, null] })), [
        { path: ["port"], message: "Missing key" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(host)({ ...value, kind: "guest" })), [
        { path: ["kind"], message: "Expected \"host\"" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(host)({ ...value, pair: [2, null] })), [{
        path: ["pair", 0],
        message: "Expected 1",
      }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(host)({ ...value, name: "a1" })), [{
        path: ["name"],
        message: "Expected name",
      }])
    }))

  it.effect("derives choices, dispatch, tagged choices, and defaults", () =>
    Effect.gen(function*() {
      const value = GrammarSchema.codec(G.choice([G.integer, G.regex(/[a-z]+/, "word")]))
      assert.equal(yield* Schema.encodeUnknownEffect(value)("abc"), "abc")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(value)(true)), [{
        path: [],
        message: "Expected number | string",
      }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(value)("A")), [{ path: [], message: "Expected word" }])

      const word = G.regex(/[a-z]+/)
      const plain = G.struct({ kind: G.as("plain")(G.empty), value: word })
      const hashed = G.struct({ kind: G.as("hashed")(G.literal("#")), value: word })
      const dispatched = GrammarSchema.codec(G.dispatch("kind", [["plain", plain], ["hashed", hashed]] as const))
      assert.deepEqual(yield* Schema.decodeEffect(dispatched)("#abc"), { kind: "hashed", value: "abc" })
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(dispatched)({ kind: "hashed", value: "a1" })), [
        { path: ["value"], message: "Expected /[a-z]+/" },
      ])

      const tagged = GrammarSchema.codec(G.taggedChoice("kind", [["n", G.integer], ["w", word]] as const))
      assert.deepEqual(yield* Schema.decodeEffect(tagged)("abc"), { kind: "w", value: "abc" })
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(tagged)({ kind: "n", value: "abc" })), [
        { path: ["value"], message: "Expected number" },
      ])

      const defaulted = GrammarSchema.codec(G.optional(G.integer).pipe(G.defaulted(7)))
      assert.equal(yield* Schema.decodeEffect(defaulted)(""), 7)
      assert.equal(yield* Schema.encodeUnknownEffect(defaulted)(7), "")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(defaulted)(undefined)), [{
        path: [],
        message: "Expected a defined value",
      }])
    }))

  it.effect("derives repetition bounds, count prefixes, labels, and recursion", () =>
    Effect.gen(function*() {
      const list = GrammarSchema.codec(G.integer.pipe(G.sepBy(",", { min: 1, max: 2 })))
      assert.deepEqual(yield* Schema.decodeEffect(list)("1,2"), [1, 2])
      for (const value of [[], [1, 2, 3]]) {
        assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(list)(value)), [
          { path: [], message: "Expected a value with a length between 1 and 2" },
        ])
      }

      const letters = GrammarSchema.codec(
        G.regex(/[a-z]/).pipe(G.label("letter"), G.countPrefixed(G.integer.pipe(G.suffix(":")))),
      )
      assert.deepEqual(yield* Schema.decodeEffect(letters)("2:ab"), ["a", "b"])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(letters)(["a", "1"])), [{
        path: [1],
        message: "Expected letter",
      }])

      const tree: G.Grammar<Tree> = G.suspend(() => G.choice([G.integer, tree.pipe(G.sepBy(","), G.between("[", "]"))]))
      const trees = GrammarSchema.codec(tree)
      assert.deepEqual(yield* Schema.decodeEffect(trees)("[1,[2,3]]"), [1, [2, 3]])
      assert.equal(yield* Schema.encodeUnknownEffect(trees)([1, [2, [3]]]), "[1,[2,[3]]]")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(trees)([1, [2, [3.5]]])), [{
        path: [1, 1, 0],
        message: "Expected an integer",
      }])
    }))

  it.effect("checks recursive references and leaves a recursive root open to further checks", () =>
    Effect.gen(function*() {
      const nonEmpty = (tree: Tree): boolean => !Array.isArray(tree) || tree.length > 0
      const tree: G.Grammar<Tree> = G.suspend(() =>
        G.choice([G.integer, tree.pipe(G.filter(nonEmpty, "a non-empty tree"), G.sepBy(","), G.between("[", "]"))])
      )
      const lists = GrammarSchema.codec(tree).check(
        Schema.makeFilter((value: Tree) => Array.isArray(value), { expected: "a list" }),
      )
      assert.deepEqual(yield* Schema.decodeEffect(lists)("[1,[2]]"), [1, [2]])
      assert.deepEqual(yield* failure(Schema.decodeEffect(lists)("1")), [{ path: [], message: "Expected a list" }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(lists)([1, [2, []]])), [{
        path: [1, 1],
        message: "Expected a non-empty tree",
      }])
    }))

  it.effect("names the transform that has no output schema and keeps the explicit-target form", () =>
    Effect.gen(function*() {
      const grammar = G.struct({
        a: G.integer.pipe(G.suffix(",")),
        b: G.integer.pipe(G.transform({ decode: String, encode: Number })),
      })
      assert.throws(
        () => GrammarSchema.codec(grammar),
        {
          message: "codec: the transform of integer at .steps[1] declares no output schema; "
            + "pass `to` to transform or transformOrFail, or pass a target schema to codec",
        },
      )
      const explicit = GrammarSchema.codec(grammar, Schema.Struct({ a: Schema.Int, b: Schema.String }))
      assert.deepEqual(yield* Schema.decodeEffect(explicit)("1,2"), { a: 1, b: "2" })
    }))

  it.effect("preserves excess fields until checked printing for filtered and dependent roots", () =>
    Effect.gen(function*() {
      const point = G.struct({ x: G.integer }).pipe(G.filter(() => true, "a point"))
      for (
        const grammar of [
          point,
          G.suspend(() => point),
          G.suspend(() => point).pipe(G.filter(() => true, "point")),
        ]
      ) {
        const codec = GrammarSchema.codec(grammar).check(Schema.makeFilter(() => true))
        assert.deepEqual(yield* Schema.decodeEffect(codec)("1"), { x: 1 })
        assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)({ x: 1, extra: 2 })), [{
          path: [],
          message: "exactly the fields x: unexpected own field",
        }])
      }
      const dependent = GrammarSchema.codec(G.gen(function*() {
        const size = yield* G.integer.pipe(G.suffix(":"))
        const body = yield* G.take(size)
        return { size, body }
      }))
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(dependent)({ size: 1, body: "a", extra: 2 })), [{
        path: [],
        message: "exactly the fields size, body: unexpected own field",
      }])
    }))

  it.effect("retains suspended output schema annotations beneath filters", () =>
    Effect.gen(function*() {
      const target = Schema.suspend(() => Schema.Struct({ x: Schema.Int })).annotate({
        expected: "DeclaredPoint",
        identifier: "DeclaredPoint",
        parseOptions: { onExcessProperty: "error" },
      })
      const point = G.integer.pipe(
        G.transform({ to: target, decode: (x) => ({ x }), encode: ({ x }) => x }),
        G.filter(() => true, "a point"),
      )
      const codec = GrammarSchema.codec(G.struct({ point }))
      assert.deepEqual(yield* Schema.decodeEffect(codec)("1"), { point: { x: 1 } })
      assert.equal(yield* Schema.encodeUnknownEffect(codec)({ point: { x: 1 } }), "1")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)({ point: { x: 1, extra: 2 } })), [{
        path: ["point", "extra"],
        message: "Expected no excess property",
      }])
      const direct = yield* failure(Schema.encodeUnknownEffect(target)("not a point"))
      assert.deepEqual(
        yield* failure(Schema.encodeUnknownEffect(codec)({ point: "not a point" })),
        direct.map((issue) => ({ ...issue, path: ["point", ...(issue.path ?? [])] })),
      )
    }))

  it.effect("derives dispatch checks on suspended branches", () =>
    Effect.gen(function*() {
      const plain = G.suspend(() => G.struct({ kind: G.empty.pipe(G.as("plain")), value: G.integer }))
      const hashed = G.suspend(() => G.struct({ kind: G.literal("#").pipe(G.as("hashed")), value: G.integer }))
      const codec = GrammarSchema.codec(G.dispatch("kind", [["plain", plain], ["hashed", hashed]] as const))
      assert.deepEqual(yield* Schema.decodeEffect(codec)("#1"), { kind: "hashed", value: 1 })
      assert.equal(yield* Schema.encodeEffect(codec)({ kind: "plain", value: 2 }), "2")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)({ kind: "hashed", value: 1.5 })), [{
        path: ["kind"],
        message: "Expected \"plain\"",
      }, {
        path: ["value"],
        message: "Expected an integer",
      }])
    }))

  it.effect("leaves left-recursive grammar diagnostics to parsing rather than overflowing during derivation", () =>
    Effect.gen(function*() {
      const recursive: G.Grammar<void> = G.suspend(() => recursive, "recursive")
      const codec = GrammarSchema.codec(recursive)
      const issues = yield* failure(Schema.decodeEffect(codec)(""))
      assert.match(issues[0]!.message, /non-left-recursive/)
    }))

  it.effect("derives without running gens, transforms, or predicates", () =>
    Effect.sync(() => {
      const calls = { gens: 0, callbacks: 0 }
      const spy = <A>(value: A): A => {
        calls.callbacks++
        return value
      }
      const grammar = G.gen(function*() {
        calls.gens++
        const size = yield* G.integer.pipe(
          G.transform({ to: Schema.Int, decode: spy, encode: spy }),
          G.filter((value: number) => spy(value >= 0), "a size"),
          G.suffix(":"),
        )
        const body = yield* G.take(size).pipe(
          G.transformOrFail({
            to: Schema.String,
            decode: (value) => spy(Result.succeed(value)),
            encode: Result.succeed,
          }),
        )
        return { size, body }
      })

      assert.deepEqual(calls, { gens: 1, callbacks: 0 })
      GrammarSchema.codec(grammar)
      assert.deepEqual(calls, { gens: 1, callbacks: 0 })
    }))
})

describe("codec(grammar) built-ins", () => {
  it.effect("checks integers, binary ranges, and full-value regex matches without annotations", () =>
    Effect.gen(function*() {
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(GrammarSchema.codec(G.integer))(2 ** 53)), [
        { path: [], message: "Expected an integer" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(GrammarSchema.codec(G.regex(/[a-z]+/)))("abc1")), [
        { path: [], message: "Expected /[a-z]+/" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.uint8))(256)), [
        { path: [], message: "Expected a value between 0 and 255" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.int16))(-32769)), [
        { path: [], message: "Expected a value between -32768 and 32767" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.uint64))(1)), [{
        path: [],
        message: "Expected bigint",
      }])
      assert.ok(
        Number.isNaN(
          yield* Schema.decodeEffect(Binary.codec(Binary.float64))(Uint8Array.of(0x7f, 0xf8, 0, 0, 0, 0, 0, 0)),
        ),
      )
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.varuint))(-1)), [
        { path: [], message: "Expected a value greater than or equal to 0" },
      ])
    }))

  it.effect("checks bit fields and text encodings", () =>
    Effect.gen(function*() {
      const bits = Binary.codec(Binary.bits({ flag: 1, rest: 7 }))
      assert.deepEqual(yield* Schema.decodeEffect(bits)(Uint8Array.of(0x81)), { flag: 1, rest: 1 })
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(bits)({ flag: 2, rest: 0 })), [{
        path: ["flag"],
        message: "Expected 0 | 1",
      }])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(bits)({ flag: 0, rest: 128 })), [
        { path: ["rest"], message: "Expected a value between 0 and 127" },
      ])

      const text = Binary.codec(Binary.utf8(Binary.lengthPrefixed(Binary.uint8)))
      assert.deepEqual(yield* Schema.encodeEffect(text)("😀"), Uint8Array.of(4, 240, 159, 152, 128))
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(text)("\uD800")), [
        { path: [], message: "Expected a string without lone surrogates" },
      ])
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.ascii(Binary.bytes(1))))("é")), [
        { path: [], message: "Expected ascii" },
      ])
    }))

  it.effect("counts text in UTF-16 code units and binary in bytes", () =>
    Effect.gen(function*() {
      const text = GrammarSchema.codec(G.take(2))
      assert.equal(yield* Schema.encodeUnknownEffect(text)("😀"), "😀")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(text)("abc")), [{
        path: [],
        message: "Expected 2 characters",
      }])
      assert.deepEqual(
        yield* failure(Schema.encodeUnknownEffect(Binary.codec(Binary.bytes(2)))(Uint8Array.of(1, 2, 3))),
        [
          { path: [], message: "Expected 2 bytes" },
        ],
      )

      const prefixed = GrammarSchema.codec(G.lengthPrefixed(G.integer.pipe(G.suffix(":"))))
      assert.equal(yield* Schema.encodeUnknownEffect(prefixed)("😀"), "2:😀")
      assert.equal(yield* Schema.decodeEffect(prefixed)("3:abc"), "abc")
    }))
})

describe("codec(grammar) custom output schemas", () => {
  const tripled = G.integer.pipe(
    G.transform({ to: Schema.Int.check(Schema.isMultipleOf(2)), decode: (n: number) => n * 3, encode: (n) => n / 3 }),
  )
  const nested = GrammarSchema.codec(G.struct({ outer: G.struct({ n: tripled }) }))

  it.effect("validates decode callback results and encode inputs at their nested paths", () =>
    Effect.gen(function*() {
      assert.deepEqual(yield* Schema.decodeEffect(nested)("2"), { outer: { n: 6 } })
      const multiple = [{ path: ["outer", "n"], message: "Expected a value that is a multiple of 2" }]
      assert.deepEqual(yield* failure(Schema.decodeEffect(nested)("1")), multiple)
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(nested)({ outer: { n: 3 } })), multiple)
    }))

  it.effect("leaves values the encode callback cannot print to checked printing", () =>
    Effect.gen(function*() {
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(nested)({ outer: { n: 4 } })), [
        { path: ["outer", "n"], message: "expected integer, got 1.3333333333333333" },
      ])
    }))

  it.effect("uses the type side of a declared codec", () =>
    Effect.gen(function*() {
      const grammar = G.regex(/\d+/).pipe(G.transform({ to: Schema.FiniteFromString, decode: Number, encode: String }))
      const codec = GrammarSchema.codec(grammar)
      assert.equal(yield* Schema.decodeEffect(codec)("12"), 12)
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)("12")), [{
        path: [],
        message: "Expected number",
      }])
    }))

  it.effect("reports throwing predicates as issues", () =>
    Effect.gen(function*() {
      const small = GrammarSchema.codec(G.integer.pipe(G.filter((n: number) => {
        if (n > 5) throw new Error("boom")
        return true
      }, "small")))
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(small)(9)), [{ path: [], message: "small: boom" }])
      assert.deepEqual(yield* failure(Schema.decodeEffect(small)("9")), [
        { path: [], message: "line 1, column 2: expected integer: boom, found end of input" },
      ])
    }))
})

describe("codec(grammar) dependencies", () => {
  it.effect("checks take, repeat, and match against bound values at nested paths", () =>
    Effect.gen(function*() {
      const sized = GrammarSchema.codec(G.gen(function*() {
        const size = yield* G.integer.pipe(G.suffix(":"))
        const body = yield* G.take(size)
        return { meta: { size }, data: { body } }
      }))
      assert.equal(yield* Schema.encodeUnknownEffect(sized)({ meta: { size: 2 }, data: { body: "ab" } }), "2:ab")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(sized)({ meta: { size: 3 }, data: { body: "ab" } })), [
        { path: ["data", "body"], message: "Expected 3 characters" },
      ])

      const counted = GrammarSchema.codec(G.gen(function*() {
        const header = yield* G.struct({ count: G.integer.pipe(G.suffix(":")) })
        const items = yield* G.regex(/[a-z]/).pipe(G.repeat(G.get(header, "count")))
        return { header, items }
      }))
      assert.deepEqual(yield* Schema.decodeEffect(counted)("2:ab"), { header: { count: 2 }, items: ["a", "b"] })
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(counted)({ header: { count: 2 }, items: ["a"] })), [
        { path: ["items"], message: "Expected 2 items" },
      ])

      const kinded = GrammarSchema.codec(G.gen(function*() {
        const kind = yield* G.literals("n", "s").pipe(G.suffix(":"))
        const body = yield* G.match(kind, [["n", G.integer], ["s", G.regex(/[a-z]+/)]] as const)
        return { kind, body }
      }))
      assert.equal(yield* Schema.encodeUnknownEffect(kinded)({ kind: "s", body: "abc" }), "s:abc")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(kinded)({ kind: "n", body: "abc" })), [
        { path: ["body"], message: "Expected a value for match case \"n\"" },
      ])
    }))

  it.effect("checks byte lengths against bound binary fields", () =>
    Effect.gen(function*() {
      const packet = Binary.codec(G.gen(function*() {
        const length = yield* Binary.uint8
        const data = yield* Binary.bytes(length)
        return { length, data }
      }))
      assert.deepEqual(yield* Schema.encodeEffect(packet)({ length: 1, data: Uint8Array.of(9) }), Uint8Array.of(1, 9))
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(packet)({ length: 2, data: Uint8Array.of(1) })), [
        { path: ["data"], message: "Expected 2 bytes" },
      ])
    }))

  it.effect("leaves dependencies inside choices to checked printing", () =>
    Effect.gen(function*() {
      const codec = GrammarSchema.codec(G.gen(function*() {
        const size = yield* G.integer.pipe(G.suffix(":"))
        const body = yield* G.choice([G.take(size), G.literal("!").pipe(G.as("!"))])
        return { size, body }
      }))
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)({ size: 3, body: "ab" })), [
        {
          path: ["body"],
          message:
            "no choice branch accepts \"ab\":\n  expected 3 characters, got \"ab\"\n  expected \"!\", got \"ab\"",
        },
      ])
    }))
})
