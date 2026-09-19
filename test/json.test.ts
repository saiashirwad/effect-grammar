import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { jsonString } from "../examples/grammars/json.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("JSON strings", () => {
  it.effect("accepts ordinary text and valid escapes", () =>
    Effect.sync(() => {
      assert.equal(parseOk(jsonString, '"hello-world"'), "hello-world")
      assert.equal(parseOk(jsonString, String.raw`"line\nbreak"`), "line\nbreak")
      assert.equal(parseOk(jsonString, String.raw`"\u0041"`), "A")
      const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
      assert.equal(parseOk(jsonString, escaped), '"\\/\b\f\n\r\tA')
    }),
  )

  it.effect("rejects invalid escapes and raw control characters", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(jsonString, '"a\\q"').expected, ["string"])
      assert.deepEqual(parseFail(jsonString, '"line\nbreak"').expected, ["string"])
      assert.deepEqual(parseFail(jsonString, `"a${String.fromCharCode(1)}b"`).expected, ["string"])
    }),
  )
})
