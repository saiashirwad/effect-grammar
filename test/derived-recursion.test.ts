import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaIssue } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import * as Binary from "../src/binary.ts"
import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const format = SchemaIssue.makeFormatterStandardSchemaV1()
const failure = <A>(effect: Effect.Effect<A, Schema.SchemaError>) =>
  Effect.map(Effect.flip(effect), (error) => format(error.issue).issues)

const parenthesized = (recursiveFirst = true): G.Grammar<number> => {
  const grammar: G.Grammar<number> = G.suspend(() => {
    const nested = grammar.pipe(G.between("(", ")"))
    return G.choice(recursiveFirst ? [nested, G.integer] : [G.integer, nested])
  })
  return grammar
}

describe("derived schema recursion", () => {
  it.effect("agrees with least-fixed-point membership for generated cyclic grammars", () =>
    Effect.sync(() => {
      const index = FastCheck.integer({ min: 0, max: 3 })
      const rules = FastCheck.array(FastCheck.tuple(index, index, index), { minLength: 4, maxLength: 4 })
      FastCheck.assert(
        FastCheck.property(rules, (definitions) => {
          const grammars: Array<G.Grammar<number>> = definitions.map(([literal, positive, even]) =>
            G.suspend(() =>
              G.choice([
                grammars[positive]!.pipe(G.between("(", ")"), G.filter((n: number) => n > 0, "positive")),
                grammars[even]!.pipe(G.between("[", "]"), G.filter((n: number) => n % 2 === 0, "even")),
                G.literal(String(literal)).pipe(G.as(literal)),
              ])
            )
          )
          const accepts = grammars.map((grammar) => Schema.is(Schema.toType(GrammarSchema.codec(grammar))))
          for (const value of [-1, 0, 1, 2, 3, 4]) {
            let membership = definitions.map(() => false)
            for (let step = 0; step < definitions.length; step++) {
              membership = definitions.map(([literal, positive, even]) =>
                value === literal || (membership[positive]! && value > 0) || (membership[even]! && value % 2 === 0)
              )
            }
            for (const [root, is] of accepts.entries()) assert.equal(is(value), membership[root])
          }
          for (const is of accepts) assert.equal(is("bad"), false)
        }),
        { numRuns: 100, seed: 7331 },
      )
    }))

  it.effect("normalizes recursive parentheses in either branch order", () =>
    Effect.gen(function*() {
      for (const recursiveFirst of [true, false]) {
        const codec = GrammarSchema.codec(parenthesized(recursiveFirst))
        assert.equal(yield* Schema.decodeEffect(codec)("((1))"), 1)
        assert.equal(yield* Schema.encodeEffect(codec)(1), "1")
        for (const invalid of ["bad", 1.5, {}, null]) {
          assert.ok(Result.isFailure(Schema.encodeUnknownResult(codec)(invalid)))
          assert.equal(Schema.is(Schema.toType(codec))(invalid), false)
        }
      }
    }))

  it.effect("preserves different filters at each root of mutual recursion", () =>
    Effect.gen(function*() {
      const positive: G.Grammar<number> = G.suspend(() =>
        number.pipe(G.between("(", ")"), G.filter((n: number) => n > 0, "positive"))
      )
      const number: G.Grammar<number> = G.suspend(() => G.choice([positive, G.integer]))
      const restricted = GrammarSchema.codec(positive)
      const unrestricted = GrammarSchema.codec(number)
      assert.equal(yield* Schema.decodeEffect(restricted)("(1)"), 1)
      assert.equal(yield* Schema.encodeEffect(restricted)(1), "(1)")
      assert.equal(yield* Schema.decodeEffect(unrestricted)("-1"), -1)
      assert.equal(Schema.is(Schema.toType(restricted))(-1), false)
      assert.equal(Schema.is(Schema.toType(unrestricted))(-1), true)
      for (const codec of [restricted, unrestricted]) {
        assert.ok(Result.isFailure(Schema.encodeUnknownResult(codec)("bad")))
      }
      const nested = GrammarSchema.codec(G.struct({ value: positive }))
      assert.deepEqual(yield* failure(Schema.encodeEffect(nested)({ value: -1 })), [{
        path: ["value"],
        message: "Expected positive",
      }])
    }))

  it.effect("distinguishes direct generator returns from structural descent", () =>
    Effect.gen(function*() {
      const direct: G.Grammar<number> = G.suspend(() =>
        G.choice([
          G.gen(function*() {
            yield* G.literal("(")
            const value = yield* direct
            yield* G.literal(")")
            return value
          }),
          G.integer,
        ])
      )
      const codec = GrammarSchema.codec(direct)
      assert.equal(yield* Schema.decodeEffect(codec)("((2))"), 2)
      assert.equal(yield* Schema.encodeEffect(codec)(2), "2")
      assert.equal(Schema.is(Schema.toType(codec))(false), false)

      type Tree = number | ReadonlyArray<Tree> | { readonly child: Tree }
      const tree: G.Grammar<Tree> = G.suspend(() =>
        G.choice([
          tree.pipe(G.between("(", ")")),
          G.struct({ child: tree.pipe(G.between("{", "}")) }),
          tree.pipe(G.sepBy(","), G.between("[", "]")),
          G.integer,
        ])
      )
      const trees = GrammarSchema.codec(tree)
      const value = { child: [1, { child: 2 }] }
      assert.deepEqual(yield* Schema.decodeEffect(trees)("({[1,{2}]})"), value)
      assert.equal(yield* Schema.encodeEffect(trees)(value), "{[1,{2}]}")
      assert.equal(Schema.is(Schema.toType(trees))({ child: ["bad"] }), false)
      assert.ok(Result.isFailure(Schema.encodeUnknownResult(trees)({ child: 1, extra: 2 })))

      type TupleTree = number | readonly [TupleTree]
      const tuple: G.Grammar<TupleTree> = G.suspend(() =>
        G.choice([
          G.tuple(tuple).pipe(G.between("[", "]")),
          G.integer,
        ])
      )
      const tuples = GrammarSchema.codec(tuple)
      assert.deepEqual(yield* Schema.decodeEffect(tuples)("[[3]]"), [[3]])
      assert.equal(yield* Schema.encodeEffect(tuples)([[3]]), "[[3]]")
      assert.equal(Schema.is(Schema.toType(tuples))([1, 2]), false)
    }))

  it.effect("retains structural recursion through library output descriptions", () =>
    Effect.gen(function*() {
      type Counted = number | ReadonlyArray<Counted>
      const counted: G.Grammar<Counted> = G.suspend(() =>
        G.choice([
          counted.pipe(G.countPrefixed(G.integer.pipe(G.suffix(":"))), G.between("[", "]")),
          G.integer,
        ])
      )
      const counts = GrammarSchema.codec(counted)
      assert.deepEqual(yield* Schema.decodeEffect(counts)("[2:1[1:2]]"), [1, [2]])
      assert.equal(yield* Schema.encodeEffect(counts)([1, [2]]), "[2:1[1:2]]")
      assert.equal(Schema.is(Schema.toType(counts))([1, ["bad"]]), false)

      type Tagged =
        | { readonly kind: "int"; readonly value: number }
        | { readonly kind: "list"; readonly value: ReadonlyArray<Tagged> }
      const tagged: G.Grammar<Tagged> = G.suspend(() =>
        G.taggedChoice(
          "kind",
          [
            ["int", G.integer],
            ["list", tagged.pipe(G.sepBy(","), G.between("[", "]"))],
          ] as const,
        )
      )
      const tags = GrammarSchema.codec(tagged)
      const value: Tagged = { kind: "list", value: [{ kind: "int", value: 2 }] }
      assert.deepEqual(yield* Schema.decodeEffect(tags)("[2]"), value)
      assert.equal(yield* Schema.encodeEffect(tags)(value), "[2]")
      assert.equal(Schema.is(Schema.toType(tags))({ kind: "int", value: [] }), false)
    }))

  it.effect("uses normalized match branches and preserves bound checks", () =>
    Effect.gen(function*() {
      const codec = GrammarSchema.codec(G.gen(function*() {
        const kind = yield* G.literals("n", "s").pipe(G.suffix(":"))
        const body = yield* G.match(kind, [["n", parenthesized()], ["s", G.regex(/[a-z]+/)]] as const)
        yield* G.literal("/")
        const size = yield* G.integer.pipe(G.suffix(":"))
        const payload = yield* G.take(size)
        return { kind, body, size, payload }
      }))
      const value = { kind: "n" as const, body: 2, size: 2, payload: "ab" }
      assert.deepEqual(yield* Schema.decodeEffect(codec)("n:((2))/2:ab"), value)
      assert.equal(yield* Schema.encodeEffect(codec)(value), "n:2/2:ab")
      assert.deepEqual(yield* failure(Schema.encodeUnknownEffect(codec)({ ...value, body: "word" })), [{
        path: ["body"],
        message: "Expected a value for match case \"n\"",
      }])
      assert.deepEqual(yield* failure(Schema.encodeEffect(codec)({ ...value, size: 3 })), [{
        path: ["payload"],
        message: "Expected 3 characters",
      }])
      assert.equal(Schema.is(Schema.toType(codec))({ ...value, body: "word" }), false)
    }))

  it.effect("preserves labels and declared schemas without running callbacks during derivation", () =>
    Effect.gen(function*() {
      const calls = { decode: 0, encode: 0, predicate: 0 }
      const even = G.integer.pipe(
        G.transform({
          to: Schema.Int.check(Schema.isMultipleOf(2)),
          decode: (value) => {
            calls.decode++
            return value
          },
          encode: (value) => {
            calls.encode++
            return value
          },
        }),
        G.filter((value: number) => {
          calls.predicate++
          return value > 0
        }, "positive"),
      )
      const recursive: G.Grammar<number> = G.suspend(() =>
        G.choice([
          recursive.pipe(G.between("(", ")")),
          even,
        ])
      )
      const codec = GrammarSchema.codec(G.struct({ value: recursive }))
      assert.deepEqual(calls, { decode: 0, encode: 0, predicate: 0 })
      assert.deepEqual(yield* Schema.decodeEffect(codec)("((2))"), { value: 2 })
      assert.ok(Result.isFailure(Schema.encodeUnknownResult(codec)({ value: 3 })))
      assert.ok(Result.isFailure(Schema.decodeResult(codec)("(3)")))
      const labelled = GrammarSchema.codec(G.struct({ value: G.suspend(() => G.regex(/\d+/).pipe(G.label("count"))) }))
      assert.deepEqual(yield* failure(Schema.encodeEffect(labelled)({ value: "bad" })), [{
        path: ["value"],
        message: "Expected count",
      }])
    }))

  it.effect("rejects empty cycles but keeps cycles with empty structural exits", () =>
    Effect.gen(function*() {
      const empty: G.Grammar<number> = G.suspend(() => empty.pipe(G.between("(", ")"), G.label("empty")))
      const codec = GrammarSchema.codec(empty)
      for (const value of [1, "bad", {}, []]) {
        assert.equal(Schema.is(Schema.toType(codec))(value), false)
        assert.ok(Result.isFailure(Schema.encodeUnknownResult(codec)(value)))
      }
      type Nested = ReadonlyArray<Nested>
      const arrays: G.Grammar<Nested> = G.suspend(() =>
        G.choice([
          arrays.pipe(G.between("(", ")")),
          arrays.pipe(G.sepBy(","), G.between("[", "]")),
        ])
      )
      const lists = GrammarSchema.codec(arrays)
      assert.deepEqual(yield* Schema.decodeEffect(lists)("([[]])"), [[]])
      assert.equal(yield* Schema.encodeEffect(lists)([[]]), "[[]]")
      assert.equal(Schema.is(Schema.toType(lists))([1]), false)
    }))

  it.effect("defaults suspended optional values in text and binary codecs", () =>
    Effect.gen(function*() {
      const grammar = G.suspend(() => G.optional(parenthesized())).pipe(G.label("optional number"), G.defaulted(7))
      const codec = GrammarSchema.codec(grammar)
      assert.equal(yield* Schema.decodeEffect(codec)(""), 7)
      assert.equal(yield* Schema.decodeEffect(codec)("((2))"), 2)
      assert.equal(yield* Schema.encodeEffect(codec)(7), "")
      assert.equal(yield* Schema.encodeEffect(codec)(2), "2")
      assert.ok(Result.isFailure(Schema.encodeUnknownResult(codec)(undefined)))
      const binary = Binary.codec(G.suspend(() => G.optional(Binary.uint8)).pipe(G.defaulted(7)))
      assert.equal(yield* Schema.decodeEffect(binary)(new Uint8Array()), 7)
      assert.deepEqual(yield* Schema.encodeEffect(binary)(7), new Uint8Array())
    }))

  it.effect("derives non-finite constants, defaults, and generator constants", () =>
    Effect.gen(function*() {
      for (const value of [Infinity, -Infinity, NaN]) {
        for (const grammar of [G.empty.pipe(G.as(value)), G.optional(G.integer).pipe(G.defaulted(value))]) {
          const codec = GrammarSchema.codec(grammar)
          assert.ok(Object.is(yield* Schema.decodeEffect(codec)(""), value))
          assert.equal(yield* Schema.encodeEffect(codec)(value), "")
        }
        const constant = GrammarSchema.codec(G.empty.pipe(G.as(value)))
        for (const other of [0, Infinity, -Infinity, NaN].filter((other) => !Object.is(other, value))) {
          assert.ok(Result.isFailure(Schema.encodeUnknownResult(constant)(other)))
        }
        const record = GrammarSchema.codec(G.gen(function*() {
          yield* G.literal("!")
          return { value }
        }))
        assert.ok(Object.is((yield* Schema.decodeEffect(record)("!")).value, value))
        assert.equal(yield* Schema.encodeEffect(record)({ value }), "!")
      }
    }))
})
