import assert from "node:assert/strict"

import { Result, Schema } from "effect"
import { describe, it } from "vitest"

import {
  grammarPostgres,
  manualPostgres,
  PostgresConnectionSchema,
  type PostgresConnection,
} from "../examples/readme-candidates/postgres.ts"

const codecs = [manualPostgres, grammarPostgres] as const
const decode = (codec: (typeof codecs)[number], source: string) =>
  Schema.decodeResult(codec)(source)
const encode = (codec: (typeof codecs)[number], value: PostgresConnection) =>
  Schema.encodeResult(codec)(value)

const valid: ReadonlyArray<readonly [string, PostgresConnection]> = [
  [
    "postgres://alice:s3cret@db.internal:5432/shop?sslmode=require&connect_timeout=10",
    {
      user: "alice",
      password: "s3cret",
      host: "db.internal",
      port: 5432,
      database: "shop",
      params: { sslmode: "require", connect_timeout: "10" },
    },
  ],
  [
    "postgres://bob@localhost/postgres",
    {
      user: "bob",
      password: undefined,
      host: "localhost",
      port: undefined,
      database: "postgres",
      params: {},
    },
  ],
  [
    "postgres://al%40ice:p%2Fq@DB.internal:0005432/shop%20db?application_name=my+app&sslmode=require",
    {
      user: "al@ice",
      password: "p/q",
      host: "DB.internal",
      port: 5432,
      database: "shop db",
      params: { application_name: "my app", sslmode: "require" },
    },
  ],
]

describe("README candidate: PostgreSQL connection strings", () => {
  it("decodes valid strings to equal values", () => {
    for (const [source, expected] of valid) {
      const results = codecs.map((codec) => decode(codec, source))
      const manual = results[0]!
      const grammar = results[1]!
      assert.ok(Result.isSuccess(manual))
      assert.ok(Result.isSuccess(grammar))
      assert.deepEqual(manual.success, expected)
      assert.deepEqual(grammar.success, expected)
      assert.deepEqual(manual.success, grammar.success)
    }
  })

  it("encodes equal values to the same canonical strings", () => {
    for (const [, value] of valid) {
      const results = codecs.map((codec) => encode(codec, value))
      const manual = results[0]!
      const grammar = results[1]!
      assert.ok(Result.isSuccess(manual))
      assert.ok(Result.isSuccess(grammar))
      assert.equal(manual.success, grammar.success)
    }
  })

  it("rejects the same important invalid-input categories", () => {
    const invalid = [
      ["wrong scheme", "postgresql://alice@db.internal/shop"],
      ["missing user", "postgres://db.internal/shop"],
      ["missing host", "postgres://alice@/shop"],
      ["missing database", "postgres://alice@db.internal"],
      ["extra path segment", "postgres://alice@db.internal/shop/extra"],
      ["invalid port", "postgres://alice@db.internal:nope/shop"],
      ["port out of range", "postgres://alice@db.internal:65536/shop"],
      ["empty password", "postgres://alice:@db.internal/shop"],
      ["fragment", "postgres://alice@db.internal/shop#fragment"],
      ["malformed user escape", "postgres://al%ZZice@db.internal/shop"],
      ["database slash escape", "postgres://alice@db.internal/shop%2Fextra"],
      ["missing query value", "postgres://alice@db.internal/shop?sslmode"],
      ["empty query key", "postgres://alice@db.internal/shop?=require"],
      ["duplicate query key", "postgres://alice@db.internal/shop?a=1&a=2"],
      ["empty query segment", "postgres://alice@db.internal/shop?a=1&&b=2"],
      ["malformed query escape", "postgres://alice@db.internal/shop?a=%ZZ"],
    ] as const

    for (const [category, source] of invalid) {
      for (const codec of codecs) {
        assert.ok(Result.isFailure(decode(codec, source)), `${category}: ${source}`)
      }
    }
  })

  it("satisfies value-to-text-to-value for both codecs", () => {
    for (const [, value] of valid) {
      for (const codec of codecs) {
        const text = Result.getOrThrow(encode(codec, value))
        assert.deepEqual(Result.getOrThrow(decode(codec, text)), value)
      }
    }
  })

  it("satisfies text-to-value-to-canonical-text for both codecs", () => {
    for (const [source] of valid) {
      const outputs = codecs.map((codec) => {
        const value = Result.getOrThrow(decode(codec, source))
        return Result.getOrThrow(encode(codec, value))
      })
      assert.equal(outputs[0], outputs[1])
    }
  })

  it("uses the same value schema at the codec boundary", () => {
    const invalidValue = {
      user: "alice",
      password: undefined,
      host: "db.internal",
      port: 0,
      database: "shop",
      params: {},
    }
    for (const codec of codecs) {
      assert.ok(Result.isFailure(Schema.encodeResult(codec)(invalidValue)))
    }
    assert.equal(Schema.is(PostgresConnectionSchema)(valid[0]![1]), true)
  })
})
