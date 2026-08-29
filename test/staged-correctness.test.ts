import assert from "node:assert/strict"

import { Result } from "effect"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { parseFail, parseOk, printFail, printOk } from "./helpers.ts"

describe("staged correctness", () => {
  it("keeps sibling gens' slots isolated", () => {
    const inner = Grammar.gen(function* () {
      const a = yield* Grammar.integer
      yield* Grammar.literal("+")
      const b = yield* Grammar.integer
      return { a, b }
    })
    const outer = Grammar.gen(function* () {
      const first = yield* inner
      yield* Grammar.literal(";")
      const second = yield* inner
      return { first, second }
    })

    assert.deepEqual(parseOk(outer, "1+2;3+4"), {
      first: { a: 1, b: 2 },
      second: { a: 3, b: 4 },
    })
    assert.equal(printOk(outer, { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } }), "1+2;3+4")
  })

  it("fails a grammar whose ref escaped its gen, at use time", () => {
    let escaped: Grammar.Grammar<string> | undefined

    Grammar.gen(function* () {
      const length = yield* Grammar.integer
      escaped = Grammar.take(length)
      return length
    })

    if (escaped === undefined) assert.fail("expected escaped grammar")
    const grammar = escaped
    assert.deepEqual(parseFail(grammar, "abc").expected, ["a bound take count"])
    const printed = Grammar.print(grammar, "abc")
    assert.ok(Result.isFailure(printed))
  })

  it("validates regex printing with the parser matcher", () => {
    const grammar = Grammar.regex(/a/m, "a")

    assert.equal(printOk(grammar, "a"), "a")
    assert.match(printFail(grammar, "a\nb").message, /does not match/)
  })

  it("parses the old global failure symbol as a value", () => {
    const value = Symbol.for("effect-grammar/fail")
    const grammar = Grammar.regex(/x/, "x").pipe(
      Grammar.transform({
        decode: () => value,
        encode: () => "x",
      }),
    )

    assert.equal(parseOk(grammar, "x"), value)
  })

  it("normalizes negative zero", () => {
    const value = parseOk(Grammar.integer, "-0")

    assert.equal(Object.is(value, -0), false)
    assert.equal(printOk(Grammar.integer, value), "0")
  })

  it("handles huge exact counts without generated grammars", () => {
    const grammar = Grammar.gen(function* () {
      const count = yield* Grammar.integer
      yield* Grammar.literal(":")
      const value = yield* Grammar.take(count)
      return { count, value }
    })

    const error = parseFail(grammar, `${Number.MAX_SAFE_INTEGER}:`)
    assert.deepEqual(error.expected, [`${Number.MAX_SAFE_INTEGER} chars`])
  })

  it("distinguishes an absent field from present undefined", () => {
    interface OptionalField {
      readonly field?: undefined
    }

    const grammar = Grammar.gen(function* () {
      yield* Grammar.literal("x")
      const value: OptionalField = { field: undefined }
      return value
    })

    assert.match(printFail(grammar, {}).message, /\.field: missing field/)
    assert.equal(printOk(grammar, { field: undefined }), "x")
  })

  it("rejects cyclic output patterns", () => {
    interface Cycle {
      self?: Cycle
    }

    const value: Cycle = {}
    value.self = value

    assert.throws(
      () =>
        Grammar.gen(function* () {
          yield* Grammar.literal("x")
          return value
        }),
      /cyclic/,
    )
  })

  it("keeps mixed match keys distinct", () => {
    const selector = Grammar.choice(
      Grammar.literal("n:").pipe(Grammar.as(1)),
      Grammar.literal("s:").pipe(Grammar.as("1")),
    )
    const grammar = Grammar.gen(function* () {
      const kind = yield* selector
      const value = yield* Grammar.matchValue(kind, [
        [1, Grammar.literal("one").pipe(Grammar.as(10))],
        ["1", Grammar.literal("string-one").pipe(Grammar.as(20))],
      ] as const)
      return { kind, value }
    })

    assert.deepEqual(parseOk(grammar, "n:one"), { kind: 1, value: 10 })
    assert.deepEqual(parseOk(grammar, "s:string-one"), { kind: "1", value: 20 })
    assert.equal(printOk(grammar, { kind: 1, value: 10 }), "n:one")
    assert.equal(printOk(grammar, { kind: "1", value: 20 }), "s:string-one")
  })

  it("contains callback failures in Result", () => {
    const total = Grammar.regex(/x/, "x").pipe(
      Grammar.transform<string, string>({
        decode: () => {
          throw new Error("decode failed")
        },
        encode: () => {
          throw new Error("encode failed")
        },
      }),
    )
    const fallible = Grammar.regex(/x/, "x").pipe(
      Grammar.transformOrFail<string, string>({
        decode: () => Result.fail({ message: "decode rejected" }),
        encode: () => Result.fail({ message: "encode rejected" }),
      }),
    )

    assert.match(parseFail(total, "x").message, /decode failed/)
    assert.match(printFail(total, "x").message, /encode failed/)
    assert.match(parseFail(fallible, "x").message, /decode rejected/)
    assert.match(printFail(fallible, "x").message, /encode rejected/)
  })

  /* eslint-disable unicorn/no-thenable -- Reserved then properties are the behavior under test. */
  it("accesses reserved ref properties through get", () => {
    const headerGrammar = Grammar.literal("h").pipe(Grammar.as({ then: "number" as const }))
    const grammar = Grammar.gen(function* () {
      const header = yield* headerGrammar
      const value = yield* Grammar.match(Grammar.get(header, "then"), {
        number: Grammar.integer,
      })
      return { header, value }
    })

    assert.deepEqual(parseOk(grammar, "h12"), { header: { then: "number" }, value: 12 })
    const output: Grammar.Type<typeof grammar> = { header: { then: "number" }, value: 3 }
    assert.equal(printOk(grammar, output), "h3")
  })
  /* eslint-enable unicorn/no-thenable */

  it("keeps structured print paths", () => {
    const grammar = Grammar.gen(function* () {
      const port = yield* Grammar.integer
      return { address: { port } }
    })

    const error = printFail(grammar, { address: { port: 1.5 } })
    assert.match(error.message, /^\.address\.port: expected integer/)
    assert.equal(error.issue._tag, "AtPath")
  })
})
