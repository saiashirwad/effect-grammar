import assert from "node:assert/strict"

import { describe, it } from "vitest"

import { jsonString } from "../examples/json.ts"
import { parseFail, parseOk } from "./helpers.ts"

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
