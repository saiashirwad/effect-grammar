import assert from "node:assert/strict"

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe } from "vitest"

import { jsonString } from "../examples/json.ts"
import { parseFail, parseOk } from "./helpers.ts"

describe("JSON strings", () => {
  it.effect("rejects invalid escapes with a ParseError", () =>
    Effect.sync(() => {
      const error = parseFail('"a\\q"', jsonString)

      assert.equal(error.expected, "string")
    }),
  )

  it.effect("accepts quoted strings and valid JSON escapes", () =>
    Effect.sync(() => {
      assert.equal(parseOk('"hello"', jsonString), "hello")

      const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
      assert.equal(parseOk(escaped, jsonString), '"\\/\b\f\n\r\tA')
    }),
  )
})
