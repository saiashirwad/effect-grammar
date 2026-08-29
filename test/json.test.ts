import assert from "node:assert/strict"

import { describe, it } from "vitest"

import { jsonString } from "../examples/grammars/json.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("JSON strings", () => {
  it("accepts ordinary text and valid escapes", () => {
    assert.equal(parseOk(jsonString, '"hello-world"'), "hello-world")
    assert.equal(parseOk(jsonString, String.raw`"line\nbreak"`), "line\nbreak")
    assert.equal(parseOk(jsonString, String.raw`"\u0041"`), "A")
    const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
    assert.equal(parseOk(jsonString, escaped), '"\\/\b\f\n\r\tA')
  })

  it("rejects invalid escapes and raw control characters", () => {
    assert.deepEqual(parseFail(jsonString, '"a\\q"').expected, ["string"])
    assert.deepEqual(parseFail(jsonString, '"line\nbreak"').expected, ["string"])
    assert.deepEqual(parseFail(jsonString, `"a${String.fromCharCode(1)}b"`).expected, ["string"])
  })
})
