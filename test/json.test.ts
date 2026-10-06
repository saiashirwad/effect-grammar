import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { jsonString, jsonValue } from "../examples/grammars/json.ts"
import { parseFail, parseOk, printFail, printOk } from "./helpers.ts"

describe("JSON strings", () => {
  it.effect("accepts ordinary text and valid escapes", () =>
    Effect.sync(() => {
      assert.equal(parseOk(jsonString, "\"hello-world\""), "hello-world")
      assert.equal(parseOk(jsonString, String.raw`"line\nbreak"`), "line\nbreak")
      assert.equal(parseOk(jsonString, String.raw`"\u0041"`), "A")
      const escaped = String.raw`"\"\\\/\b\f\n\r\t\u0041"`
      assert.equal(parseOk(jsonString, escaped), "\"\\/\b\f\n\r\tA")
    }))

  it.effect("rejects invalid escapes and raw control characters", () =>
    Effect.sync(() => {
      assert.deepEqual(parseFail(jsonString, "\"a\\q\"").expected, ["string"])
      assert.deepEqual(parseFail(jsonString, "\"line\nbreak\"").expected, ["string"])
      assert.deepEqual(parseFail(jsonString, `"a${String.fromCharCode(1)}b"`).expected, ["string"])
    }))
})

describe("JSON values", () => {
  it.effect("round-trips nested objects and keeps arrays distinct from objects", () =>
    Effect.sync(() => {
      const value = { items: [1, "two", null, true, { nested: false }], emptyArray: [], emptyObject: {} }
      const text = printOk(jsonValue, value)
      assert.deepEqual(parseOk(jsonValue, text), value)
      assert.equal(printOk(jsonValue, []), "[]")
      assert.equal(printOk(jsonValue, {}), "{}")
    }))

  it.effect("rejects non-finite numbers on parsing and printing", () =>
    Effect.sync(() => {
      for (const source of ["1e999", "-1e999", "[1e999]", "{\"n\":1e999}"]) parseFail(jsonValue, source)
      for (const value of [Number.NaN, Infinity, -Infinity]) {
        printFail(jsonValue, value)
        printFail(jsonValue, [value])
        printFail(jsonValue, { n: value })
      }
    }))
})
