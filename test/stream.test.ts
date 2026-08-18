import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect, Ref, Schema, Stream } from "effect"

import { char, endOfInput, regex as parseRegex } from "../src/combinators.ts"
import { ParseError, UpstreamError } from "../src/error.ts"
import * as Grammar from "../src/grammar.ts"
import { makeStringState, ParseState, peek, release, seek } from "../src/state.ts"
import { parseStream } from "../src/stream.ts"

describe("streamElements", () => {
  it("emits one value per element across chunk boundaries", () => {
    const line = Grammar.map(
      Grammar.struct({
        n: Grammar.integer,
        nl: Grammar.literal("\n"),
      }),
      {
        to: ({ n }) => n,
        from: (n: number) => ({ n, nl: "\n" as const }),
      },
    )
    const chunks = Stream.fromIterable(["1\n2", "\n3\n"])
    const values = Effect.runSync(Grammar.streamElements(chunks, line).pipe(Stream.runCollect))
    assert.deepEqual([...values], [1, 2, 3])
  })

  it("dies when an element succeeds without consuming input", () => {
    // optional succeeds with undefined without consuming when the token is absent
    const zeroWidth = Grammar.optional(Grammar.literal("z"))
    const chunks = Stream.fromIterable(["x"])
    assert.throws(
      () => Effect.runSync(Grammar.streamElements(chunks, zeroWidth).pipe(Stream.runCollect)),
      (err: unknown) =>
        err instanceof Error && err.message.includes("succeeded without consuming input"),
    )
  })
})

describe("parseStream", () => {
  it("extends a parser regex match across chunk boundaries", () => {
    const parser = Effect.gen(function* () {
      const word = yield* parseRegex(/[a-z]+/, "word")
      yield* endOfInput
      return word
    })
    const chunks = Stream.fromIterable(["ab", "cd"])
    assert.equal(Effect.runSync(parseStream(chunks, parser)), "abcd")
  })

  it("parses a regex-based grammar across chunks", () => {
    const chunks = Stream.fromIterable(["12", "34"])
    assert.equal(
      Effect.runSync(Grammar.parseStream(chunks, Grammar.regex(/\d+/, "digits"))),
      "1234",
    )
  })

  it("parses a single value across chunks with strict EOF", () => {
    const chunks = Stream.fromIterable(["he", "llo"])
    const a = Effect.runSync(Grammar.parseStream(chunks, Grammar.literal("hello")))
    assert.equal(a, "hello")
  })

  it("surfaces UpstreamError when the chunk source fails", () => {
    const boom = Stream.fail("upstream-broke")
    const r = Effect.runSync(Effect.result(parseStream(boom, char("a"))))
    assert.equal(r._tag, "Failure")
    if (r._tag === "Failure") {
      assert.ok(Schema.is(UpstreamError)(r.failure))
    }
  })

  it("fails with ParseError when the grammar does not match", () => {
    const chunks = Stream.fromIterable(["nope"])
    const r = Effect.runSync(Effect.result(Grammar.parseStream(chunks, Grammar.literal("yes"))))
    assert.equal(r._tag, "Failure")
    if (r._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(r.failure))
      assert.equal(r.failure.expected, '"yes"')
    }
  })
})

describe("released parser state", () => {
  it("drops consumed input while preserving the cursor", () => {
    const state = Effect.runSync(makeStringState("abc"))
    const snapshot = Effect.runSync(
      Effect.gen(function* () {
        yield* seek(2)
        yield* release
        const current = yield* ParseState
        return {
          base: yield* Ref.get(current.base),
          buffer: yield* Ref.get(current.buffer),
          peek: yield* peek,
          pos: yield* Ref.get(current.pos),
        }
      }).pipe(Effect.provideService(ParseState, state)),
    )

    assert.deepEqual(snapshot, { base: 2, buffer: "c", peek: "c", pos: 2 })
  })

  it("defects when rewinding before released input", () => {
    const state = Effect.runSync(makeStringState("abc"))
    const rewind = Effect.gen(function* () {
      yield* seek(2)
      yield* release
      yield* seek(1)
    }).pipe(Effect.provideService(ParseState, state))

    assert.throws(() => Effect.runSync(rewind), /cannot rewind to position 1/)
  })
})
