import assert from "node:assert/strict"

import { Result } from "effect"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { parseOk, printOk } from "./helpers.ts"

const word = Grammar.regex(/[a-z]+/, "word")

describe("product and conditional APIs", () => {
  it("defaults an omitted value and omits the default when printing", () => {
    const port = Grammar.optional(Grammar.integer.pipe(Grammar.prefix(":"))).pipe(
      Grammar.defaulted(443),
    )

    assert.equal(parseOk(port, ""), 443)
    assert.equal(parseOk(port, ":80"), 80)
    assert.equal(printOk(port, 443), "")
    assert.equal(printOk(port, 80), ":80")
  })

  it("supports data-last delimiters and optional", () => {
    const grammar = Grammar.integer.pipe(
      Grammar.between("[", "]"),
      Grammar.prefix("#"),
      Grammar.suffix(";"),
      Grammar.optional(),
    )

    assert.equal(parseOk(grammar, "#[2];"), 2)
    assert.equal(parseOk(grammar, ""), undefined)
    assert.equal(printOk(grammar, 3), "#[3];")
    assert.equal(printOk(grammar, undefined), "")
  })

  it("builds explicit structs and tuples", () => {
    const record = Grammar.struct({
      host: word,
      port: Grammar.integer.pipe(Grammar.prefix(":")),
    })
    const pair = Grammar.tuple(Grammar.integer, word.pipe(Grammar.prefix(",")))

    assert.deepEqual(parseOk(record, "host:80"), { host: "host", port: 80 })
    assert.equal(printOk(record, { host: "server", port: 443 }), "server:443")
    assert.deepEqual(parseOk(pair, "1,name"), [1, "name"])
    assert.equal(printOk(pair, [2, "value"]), "2,value")
  })

  it("represents branch choice with a semantic tag", () => {
    const grammar = Grammar.taggedChoice("kind", {
      number: Grammar.integer,
      word,
    })

    assert.deepEqual(parseOk(grammar, "12"), { kind: "number", value: 12 })
    assert.deepEqual(parseOk(grammar, "name"), { kind: "word", value: "name" })
    assert.equal(printOk(grammar, { kind: "number", value: 3 }), "3")
    assert.equal(printOk(grammar, { kind: "word", value: "value" }), "value")
  })
})

describe("trivia APIs", () => {
  it("separates exact and canonical spaces", () => {
    const exact = Grammar.between(Grammar.space, Grammar.integer, Grammar.space)
    const canonical = Grammar.between(Grammar.spaces, Grammar.integer, Grammar.spaces)

    assert.equal(parseOk(exact, " 1 "), 1)
    assert.equal(printOk(exact, 2), " 2 ")
    assert.equal(parseOk(canonical, "\t 3\n"), 3)
    assert.equal(printOk(canonical, 4), " 4 ")
  })

  it("renders context-free grammars as EBNF", () => {
    const grammar = Grammar.tuple(word, Grammar.integer.pipe(Grammar.prefix(":")))
    const rendered = Grammar.toEBNF(grammar)

    assert.ok(Result.isSuccess(rendered))
    if (Result.isSuccess(rendered)) assert.equal(rendered.success, '<word> ":" <integer>')
    assert.equal(Grammar.describe(word), "word")
  })
})
