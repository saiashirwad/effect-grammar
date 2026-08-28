import assert from "node:assert/strict"

import { Schema } from "effect"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { parseFail, parseOk } from "./helpers.ts"

const jsonString: Grammar.Grammar<string> = Grammar.lexeme(
  Grammar.regex(/"(?:[^"\\-]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/, "string"),
).pipe(Grammar.decodeTo(Schema.String)({ decode: JSON.parse, encode: JSON.stringify }))

describe("JSON strings", () => {
  it("rejects invalid escapes with a ParseError", () => {
    const error = parseFail(jsonString, '"a\\q"')
    assert.deepEqual(error.expected, ["string"])
  })

  it("accepts quoted strings and valid JSON escapes", () => {
    assert.equal(parseOk(jsonString, '"hello"'), "hello")

    const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
    assert.equal(parseOk(jsonString, escaped), '"\\/\b\f\n\r\tA')
  })
})
