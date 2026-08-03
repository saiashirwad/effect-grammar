import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect, Schema } from "effect"

import { attempt, char, many, or_, parse, ParseError, regex } from "../src/parser.ts"

const run = <A, E>(input: string, p: Effect.Effect<A, E, any>) => Effect.runSync(parse(input, p))

describe("parser combinators", () => {
  it("or_ commits after consuming input", () => {
    const ab = Effect.gen(function* () {
      yield* char("a")
      yield* char("b")
      return "ab" as const
    })
    const ac = Effect.gen(function* () {
      yield* char("a")
      yield* char("c")
      return "ac" as const
    })
    const r = run("ac", or_(ab, ac))
    assert.equal(r._tag, "Failure")
    if (r._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(r.failure))
      assert.equal(r.failure.pos, 1)
      assert.equal(r.failure.expected, '"b"')
      assert.equal(r.failure.line, 1)
      assert.equal(r.failure.column, 2)
    }
  })

  it("attempt rewinds so or_ can try the next option", () => {
    const ab = Effect.gen(function* () {
      yield* char("a")
      yield* char("b")
      return "ab" as const
    })
    const ac = Effect.gen(function* () {
      yield* char("a")
      yield* char("c")
      return "ac" as const
    })
    const r = run("ac", or_(attempt(ab), ac))
    assert.equal(r._tag, "Success")
    if (r._tag === "Success") assert.equal(r.success, "ac")
  })

  it("many dies on zero-width success", () => {
    const zero = Effect.succeed("x")
    assert.throws(
      () => Effect.runSync(parse("", many(zero))),
      (err: unknown) =>
        err instanceof Error && err.message.includes("succeeded without consuming input"),
    )
  })

  it("regex tolerates a shared /g RegExp", () => {
    const re = /\d/g
    const two = Effect.gen(function* () {
      const a = yield* regex(re, "digit")
      const b = yield* regex(re, "digit")
      return [a, b] as const
    })
    const r = run("12", two)
    assert.equal(r._tag, "Success")
    if (r._tag === "Success") assert.deepEqual(r.success, ["1", "2"])
  })

  it("attaches line and column on ParseError", () => {
    const r = run(
      "a\nb",
      Effect.gen(function* () {
        yield* char("a")
        yield* char("\n")
        yield* char("c")
      }),
    )
    assert.equal(r._tag, "Failure")
    if (r._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(r.failure))
      assert.equal(r.failure.line, 2)
      assert.equal(r.failure.column, 1)
      assert.match(r.failure.message, /line 2, column 1/)
    }
  })
})
