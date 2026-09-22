import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Equal, Hash, Result, Schema, SchemaIssue } from "effect"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"
import { parseFail, printFail } from "./helpers.ts"

const wrappers = <A, D extends G.Domain>(grammar: G.Grammar<A, D>): ReadonlyArray<G.Grammar<A, D>> => [
  grammar,
  grammar.pipe(G.transform({ decode: (value) => value, encode: (value) => value })),
  G.suspend(() => grammar),
  grammar.pipe(G.label("wrapped")),
  grammar.pipe(G.between(G.empty, G.empty)),
]

class ThrowingEquality {
  [Hash.symbol]() {
    return 0
  }
  [Equal.symbol](): boolean {
    throw new Error("equality failed")
  }
}

describe("operational exceptions", () => {
  it.effect("keeps decoder, encoder, and predicate failures consistent through wrappers", () =>
    Effect.sync(() => {
      const boom = () => {
        throw new Error("callback failed")
      }
      const grammars = [
        G.regex(/x/).pipe(G.transform<string, string>({ decode: boom, encode: boom })),
        G.regex(/x/).pipe(G.filter(boom, "checked")),
      ]
      for (const grammar of grammars) {
        const parsed = parseFail(grammar, "x")
        const printed = printFail(grammar, "x")
        assert.match(parsed.message, /callback failed/)
        assert.match(printed.message, /callback failed/)
        for (const wrapped of wrappers(grammar)) {
          assert.deepEqual(parseFail(wrapped, "x").expected, parsed.expected)
          assert.equal(parseFail(wrapped, "x").pos, 1)
          assert.deepEqual(printFail(wrapped, "x").issue, printed.issue)
        }
      }
    }))

  it.effect("retains dispatch hasOwn trap paths and stops before later items", () =>
    Effect.sync(() => {
      const value = new Proxy(
        { kind: "x" as const },
        {
          getOwnPropertyDescriptor() {
            throw new Error("tag descriptor failed")
          },
        },
      )
      const item = G.dispatch("kind", [["x", G.literal("x").pipe(G.as({ kind: "x" as const }))]])
      let later = 0
      const items = [
        value,
        {
          get kind(): "x" {
            later++
            return "x"
          },
        },
      ]
      for (const wrapped of wrappers(item)) {
        const error = printFail(G.struct({ items: wrapped.pipe(G.many()) }), { items })
        assert.match(error.message, /^\.items\[0\]\.kind: a readable field: tag descriptor failed$/)
      }
      assert.equal(later, 0)
    }))

  it.effect("retains tuple and repeat element paths and does not read later elements", () =>
    Effect.sync(() => {
      for (const grammar of [G.tuple(G.integer, G.integer, G.integer), G.integer.pipe(G.repeat(3))]) {
        const reads: Array<number> = []
        const values = new Proxy([1, 2, 3], {
          get(target, key) {
            if (key === "0" || key === "1" || key === "2") {
              reads.push(Number(key))
              if (key === "1") throw new Error("element failed")
              return target[Number(key)]
            }
            return key === "length" ? target.length : undefined
          },
        })
        // SAFETY: the array has exactly the tuple's three elements.
        const error = printFail(G.struct({ values: grammar }), { values } as never)
        assert.match(error.message, /^\.values\[1\]: a readable array element: element failed$/)
        assert.deepEqual(reads, [0, 1])
      }
    }))

  it.effect("retains nested own-key and revoked-proxy inspection failures", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const value = yield* G.integer
        return { nested: { value } }
      })
      const nested = new Proxy(
        { value: 1 },
        {
          ownKeys() {
            throw new Error("keys failed")
          },
        },
      )
      assert.match(printFail(grammar, { nested }).message, /^\.nested: .*could not inspect own fields: keys failed$/)
      const revoked = Proxy.revocable({ value: 1 }, {})
      revoked.revoke()
      assert.match(printFail(grammar, { nested: revoked.proxy }).message, /^\.nested: .*revoked/)
    }))

  it.effect("returns expression getter and hasOwn failures from both interpreters at the dependent field", () =>
    Effect.sync(() => {
      const getter = {
        get size(): number {
          throw new Error("size failed")
        },
      }
      const trap = new Proxy(
        { size: 1 },
        {
          getOwnPropertyDescriptor() {
            throw new Error("size failed")
          },
        },
      )
      for (const header of [getter, trap]) {
        let later = 0
        const grammar = G.gen(function*() {
          const info = yield* G.literal("!").pipe(
            G.transform<void, typeof header>({ decode: () => header, encode: () => undefined }),
          )
          const body = yield* G.take(G.get(info, "size"))
          yield* G.suspend(() => {
            later++
            return G.empty
          })
          return { info, body }
        })
        for (const wrapped of wrappers(grammar)) {
          const parsed = parseFail(wrapped, "!x")
          assert.equal(parsed.pos, 1)
          assert.deepEqual(parsed.expected, ["take: size failed"])
          assert.match(printFail(wrapped, { info: header, body: "x" }).message, /^\.body: take: size failed$/)
        }
        assert.equal(later, 0)
      }
    }))

  it.effect("contains equality hooks in whole-output, local choice, and constant checks", () =>
    Effect.sync(() => {
      const grammar = G.literal("x").pipe(
        G.transform<void, ThrowingEquality>({ decode: () => new ThrowingEquality(), encode: () => undefined }),
      )
      assert.equal(Result.getOrThrow(G.printUnchecked(grammar, new ThrowingEquality())), "x")
      for (const wrapped of wrappers(grammar)) {
        assert.match(printFail(wrapped, new ThrowingEquality()).message, /round-trip equality: equality failed/)
      }
      const local = G.choice([grammar], { print: "roundTrip" })
      for (const print of [G.print, G.printUnchecked]) {
        const result = print(local, new ThrowingEquality())
        assert.ok(Result.isFailure(result))
        assert.equal(result.failure.issue._tag, "NoAlternative")
        assert.match(result.failure.message, /equality failed/)
      }
      const constant = G.struct({ nested: G.literal("x").pipe(G.as(new ThrowingEquality())) })
      assert.match(printFail(constant, { nested: new ThrowingEquality() }).message, /^\.nested: .*equality failed$/)
      const value = new ThrowingEquality()
      const fallback = G.literal("y").pipe(
        G.transform<void, ThrowingEquality>({ decode: () => value, encode: () => undefined }),
      )
      assert.equal(Result.getOrThrow(G.print(G.choice([grammar, fallback], { print: "roundTrip" }), value)), "y")
    }))

  it.effect("maps inspection paths to Schema pointers", () =>
    Effect.gen(function*() {
      const grammar = G.struct({ items: G.integer.pipe(G.many()) })
      const values = [1, 2]
      Object.defineProperty(values, 1, {
        get() {
          throw new Error("schema element failed")
        },
      })
      const codec = GrammarSchema.codec(grammar, Schema.Unknown)
      const error = yield* Effect.flip(Schema.encodeEffect(codec)({ items: values }))
      assert.match(SchemaIssue.makeFormatterDefault()(error.issue), /\["items"\]\[1\]/)
      assert.match(SchemaIssue.makeFormatterDefault()(error.issue), /schema element failed/)
    }))

  it.effect("contains hostile thrown values even when their message cannot be read", () =>
    Effect.sync(() => {
      const error = new Proxy(new Error("hidden"), {
        get() {
          throw new Error("message failed")
        },
      })
      const grammar = G.regex(/x/).pipe(
        G.transform<string, string>({
          decode: () => {
            throw error
          },
          encode: () => {
            throw error
          },
        }),
      )
      assert.match(parseFail(grammar, "x").message, /<unprintable value>/)
      assert.match(printFail(grammar, "x").message, /<unprintable value>/)
    }))
})

describe("binary operational diagnostics", () => {
  it.effect("uses byte parse semantics and Uint8Array output in whole and local round-trip failures", () =>
    Effect.sync(() => {
      const grammar = B.uint8.pipe(
        G.transformOrFail({
          decode: () => Result.fail("a decoded value"),
          encode: (value: number) => Result.succeed(value),
        }),
      )
      const bytes = Uint8Array.of(10)
      const parsed = B.parse(grammar, bytes)
      const printed = B.print(grammar, 10)
      assert.ok(Result.isFailure(parsed))
      assert.ok(Result.isFailure(printed))
      const issue = printed.failure.issue
      assert.equal(issue._tag, "RoundTrip")
      if (issue._tag === "RoundTrip") {
        assert.deepEqual(issue.printed, bytes)
        assert.equal(issue.error, parsed.failure.message)
      }
      assert.match(printed.failure.message, /prints as <0a>.*byte 1:/)
      assert.doesNotMatch(printed.failure.message, /line|column|\\n/)
      const local = B.printUnchecked(G.choice([grammar], { print: "roundTrip" }), 10)
      assert.ok(Result.isFailure(local))
      assert.match(local.failure.message, /prints as <0a>.*byte 1:/)
      const lossy = B.uint8.pipe(G.transform({ decode: (value) => value + 1, encode: (value: number) => value }))
      const mismatch = B.print(lossy, 255)
      assert.ok(Result.isFailure(mismatch))
      assert.match(mismatch.failure.message, /prints as <ff>, which reads back as 256/)
    }))

  it.effect("uses the enclosing environment while searching binary round-trip branches", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const length = yield* B.uint8
        const body = B.bytes(length)
        const plain = body.pipe(
          G.filter((bytes: Uint8Array) => bytes.every((byte) => byte < 128), "low bytes"),
          G.transform({
            decode: (bytes) => ({ kind: "plain", bytes }),
            encode: (value: { kind: string; bytes: Uint8Array }) => value.bytes,
          }),
        )
        const tagged = body.pipe(
          G.prefix(B.literal(0xff)),
          G.transform({
            decode: (bytes) => ({ kind: "tagged", bytes }),
            encode: (value: { kind: string; bytes: Uint8Array }) => value.bytes,
          }),
        )
        const payload = yield* G.choice([plain, tagged], { print: "roundTrip" })
        return { length, payload }
      })
      const value = { length: 2, payload: { kind: "tagged", bytes: Uint8Array.of(65, 66) } }
      for (const print of [B.print, B.printUnchecked]) {
        assert.deepEqual(Result.getOrThrow(print(grammar, value)), Uint8Array.of(2, 255, 65, 66))
      }
    }))

  it.effect("retains Schema pointers and byte diagnostics for a nested choice round-trip failure", () =>
    Effect.gen(function*() {
      const item = B.uint8.pipe(
        G.transformOrFail({
          decode: () => Result.fail("a decoded value"),
          encode: (value: number) => Result.succeed(value),
        }),
      )
      const grammar = G.struct({ payload: G.choice([item], { print: "roundTrip" }) })
      const codec = B.codec(grammar, Schema.Unknown)
      const error = yield* Effect.flip(Schema.encodeEffect(codec)({ payload: 10 }))
      const message = SchemaIssue.makeFormatterDefault()(error.issue)
      assert.match(message, /\["payload"\]/)
      assert.match(message, /prints as <0a>.*byte 1:/)
      assert.doesNotMatch(message, /line|column/)
    }))

  it.effect("contains binary callbacks, lazy resolution, inspection, and equality failures", () =>
    Effect.sync(() => {
      const broken = B.uint8.pipe(
        G.transform<number, number>({
          decode() {
            throw new Error("binary decode failed")
          },
          encode() {
            throw new Error("binary encode failed")
          },
        }),
      )
      for (const grammar of wrappers(broken)) {
        const parsed = B.parse(grammar, Uint8Array.of(0xff))
        const printed = B.print(grammar, 1)
        assert.ok(Result.isFailure(parsed))
        assert.ok(Result.isFailure(printed))
        assert.match(parsed.failure.message, /byte 1: .*binary decode failed/)
        assert.match(printed.failure.message, /binary encode failed/)
      }
      const lazy = G.suspend<number, "bytes">(() => {
        throw new Error("binary thunk failed")
      })
      assert.ok(Result.isFailure(B.parse(lazy, Uint8Array.of(1))))
      assert.ok(Result.isFailure(B.print(lazy, 1)))
      const equality = B.uint8.pipe(G.transform({ decode: () => new ThrowingEquality(), encode: () => 1 }))
      for (const grammar of [equality, G.choice([equality], { print: "roundTrip" })]) {
        const printed = B.print(grammar, new ThrowingEquality())
        assert.ok(Result.isFailure(printed))
        assert.match(printed.failure.message, /equality failed/)
      }
      const values = [1]
      Object.defineProperty(values, 0, {
        get() {
          throw new Error("byte element failed")
        },
      })
      const printed = B.print(B.uint8.pipe(G.many()), values)
      assert.ok(Result.isFailure(printed))
      assert.match(printed.failure.message, /^\[0\]: .*byte element failed/)
      const unreadable = new Proxy(Uint8Array.of(1), {
        get() {
          throw new Error("byte input failed")
        },
      })
      const parsed = B.parse(B.uint8, unreadable)
      assert.ok(Result.isFailure(parsed))
      assert.match(parsed.failure.message, /byte 0: .*byte input failed/)
    }))
})
