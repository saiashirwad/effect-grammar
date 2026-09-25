import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as Grammar from "../src/index.ts"
import { parseOk, printOk } from "./helpers.ts"

const word = Grammar.regex(/[a-z]+/, "word")

describe("product and conditional APIs", () => {
  it.effect("defaults an omitted value and omits the default when printing", () =>
    Effect.sync(() => {
      const port = Grammar.optional(Grammar.integer.pipe(Grammar.prefix(":"))).pipe(Grammar.defaulted(443))

      assert.equal(parseOk(port, ""), 443)
      assert.equal(parseOk(port, ":80"), 80)
      assert.equal(printOk(port, 443), "")
      assert.equal(printOk(port, 80), ":80")
    }))

  it.effect("does not replace an explicitly parsed null with the default", () =>
    Effect.sync(() => {
      const nullable = Grammar.choice([Grammar.literal("null").pipe(Grammar.as(null)), Grammar.integer])
      const grammar = Grammar.optional(nullable).pipe(Grammar.defaulted<number | null>(0))

      assert.equal(parseOk(grammar, "null"), null)
      assert.equal(printOk(grammar, null), "null")
      assert.equal(Result.getOrThrow(Grammar.print(grammar, null)), "null")
      assert.equal(parseOk(grammar, ""), 0)
      assert.equal(printOk(grammar, 0), "")
      assert.equal(Result.getOrThrow(Grammar.print(grammar, 0)), "")
    }))

  it.effect("supports data-last delimiters and optional", () =>
    Effect.sync(() => {
      const grammar = Grammar.integer.pipe(
        Grammar.between("[", "]"),
        Grammar.prefix("#"),
        Grammar.suffix(";"),
        Grammar.optional,
      )

      assert.equal(parseOk(grammar, "#[2];"), 2)
      assert.equal(parseOk(grammar, ""), undefined)
      assert.equal(printOk(grammar, 3), "#[3];")
      assert.equal(printOk(grammar, undefined), "")
    }))

  it.effect("builds explicit structs and tuples", () =>
    Effect.sync(() => {
      const record = Grammar.struct({
        host: word,
        port: Grammar.integer.pipe(Grammar.prefix(":")),
      })
      const pair = Grammar.tuple(Grammar.integer, word.pipe(Grammar.prefix(",")))

      assert.deepEqual(parseOk(record, "host:80"), { host: "host", port: 80 })
      assert.equal(printOk(record, { host: "server", port: 443 }), "server:443")
      assert.deepEqual(parseOk(pair, "1,name"), [1, "name"])
      assert.equal(printOk(pair, [2, "value"]), "2,value")
    }))

  it.effect("represents branch choice with a semantic tag", () =>
    Effect.sync(() => {
      const grammar = Grammar.taggedChoice(
        "kind",
        [
          ["number", Grammar.integer],
          ["word", word],
        ] as const,
      )

      assert.deepEqual(parseOk(grammar, "12"), { kind: "number", value: 12 })
      assert.deepEqual(parseOk(grammar, "name"), { kind: "word", value: "name" })
      assert.equal(printOk(grammar, { kind: "number", value: 3 }), "3")
      assert.equal(printOk(grammar, { kind: "word", value: "value" }), "value")
    }))
})

describe("trivia APIs", () => {
  it.effect("separates exact and canonical spaces", () =>
    Effect.sync(() => {
      const exact = Grammar.integer.pipe(Grammar.between(Grammar.space, Grammar.space))
      const canonical = Grammar.integer.pipe(Grammar.between(Grammar.spaces, Grammar.spaces))

      assert.equal(parseOk(exact, " 1 "), 1)
      assert.equal(printOk(exact, 2), " 2 ")
      assert.equal(parseOk(canonical, "\t 3\n"), 3)
      assert.equal(printOk(canonical, 4), " 4 ")
    }))

  it.effect("describes grammars shallowly", () =>
    Effect.sync(() => {
      assert.equal(Grammar.describe(word), "word")
    }))
})
