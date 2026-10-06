import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import { Dsn } from "../examples/grammars/connection-string.ts"
import { query } from "../examples/grammars/query.ts"
import * as Grammar from "../src/index.ts"

const params = [
  { key: "user", value: "alice" },
  { key: "mode", value: "fast" },
  { key: "user", value: "bob" },
]
const source = "?user=alice&mode=fast&user=bob"

describe("query example value shapes", () => {
  it.effect("printing preserves duplicate keys and their order", () =>
    Effect.sync(() => {
      assert.deepEqual(Result.getOrThrow(Grammar.parse(query, source)), params)
      assert.equal(Result.getOrThrow(Grammar.print(query, params)), source)
    }))

  it.effect("connection strings preserve duplicate keys through the derived codec", () =>
    Effect.gen(function*() {
      const text = `postgres://alice@localhost/shop${source}`
      const value = yield* Schema.decodeEffect(Dsn)(text)
      assert.deepEqual(value.params, params)
      assert.equal(yield* Schema.encodeEffect(Dsn)(value), text)
    }))

  it.effect("connection strings distinguish absent, empty, and empty-valued parameters", () =>
    Effect.gen(function*() {
      for (
        const [suffix, expected] of [
          ["", undefined],
          ["?", []],
          ["?user=", [{ key: "user", value: "" }]],
        ] as const
      ) {
        const text = `postgres://alice@localhost/shop${suffix}`
        const value = yield* Schema.decodeEffect(Dsn)(text)
        assert.deepEqual(value.params, expected)
        assert.equal(yield* Schema.encodeEffect(Dsn)(value), text)
      }
    }))
})
