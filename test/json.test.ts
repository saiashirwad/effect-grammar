import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { jsonString } from "../examples/json.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("JSON strings", () => {
  it("rejects invalid escapes with a ParseError", () => {
    const error = parseFail('"a\\q"', jsonString)

    assert.equal(error.expected, "string")
  })

  it("accepts quoted strings and valid JSON escapes", () => {
    assert.equal(parseOk('"hello"', jsonString), "hello")

    const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
    assert.equal(parseOk(escaped, jsonString), '"\\/\b\f\n\r\tA')
  })
})
