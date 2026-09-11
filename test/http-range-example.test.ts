import assert from "node:assert/strict"

import { Result, Schema } from "effect"
import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"

import {
  ByteRangeCodec,
  type ByteRangesValue,
  ManualByteRangeCodec,
} from "../examples/http-range.ts"

const codecs = [ManualByteRangeCodec, ByteRangeCodec] as const
const decode = (codec: (typeof codecs)[number], source: string) =>
  Schema.decodeResult(codec)(source)
const encode = (codec: (typeof codecs)[number], value: ByteRangesValue) =>
  Schema.encodeResult(codec)(value)

const values: ReadonlyArray<ByteRangesValue> = [
  [{ kind: "closed", start: 0, end: 499 }],
  [
    { kind: "closed", start: 0, end: 499 },
    { kind: "open", start: 500 },
    { kind: "suffix", length: 200 },
  ],
]

const padding = FastCheck.integer({ min: 0, max: 3 })
const padded = (value: number, zeroes: number): string => `${"0".repeat(zeroes)}${value}`
const rangeText = FastCheck.oneof(
  FastCheck.tuple(
    FastCheck.integer({ min: 0, max: 1_000 }),
    FastCheck.integer({ min: 0, max: 1_000 }),
    padding,
    padding,
  ).map(
    ([start, width, startZeroes, endZeroes]) =>
      `${padded(start, startZeroes)}-${padded(start + width, endZeroes)}`,
  ),
  FastCheck.tuple(FastCheck.integer({ min: 0, max: 1_000 }), padding).map(
    ([start, zeroes]) => `${padded(start, zeroes)}-`,
  ),
  FastCheck.tuple(FastCheck.integer({ min: 1, max: 1_000 }), padding).map(
    ([length, zeroes]) => `-${padded(length, zeroes)}`,
  ),
)

describe("HTTP range example parity", () => {
  it("decodes valid strings to equal values", () => {
    for (const source of ["bytes=0-499", "bytes=000-499,500-,-200"]) {
      const results = codecs.map((codec) => decode(codec, source))
      const manual = results[0]!
      const grammar = results[1]!
      assert.ok(Result.isSuccess(manual))
      assert.ok(Result.isSuccess(grammar))
      assert.deepEqual(grammar.success, manual.success)
    }
  })

  it("encodes equal values to the same canonical string", () => {
    for (const value of values) {
      const results = codecs.map((codec) => encode(codec, value))
      const manual = results[0]!
      const grammar = results[1]!
      assert.ok(Result.isSuccess(manual))
      assert.ok(Result.isSuccess(grammar))
      assert.equal(grammar.success, manual.success)
    }
  })

  it("rejects the same important invalid-input categories", () => {
    const invalid = [
      "items=0-1",
      "bytes=",
      "bytes=0",
      "bytes=0-1,",
      "bytes=5-2",
      "bytes=-0",
      "bytes=9007199254740992-",
    ]
    for (const source of invalid) {
      for (const codec of codecs) assert.ok(Result.isFailure(decode(codec, source)), source)
    }
  })

  it("round-trips values through the same canonical text", () => {
    for (const value of values) {
      for (const codec of codecs) {
        const encoded = Result.getOrThrow(encode(codec, value))
        assert.deepEqual(Result.getOrThrow(decode(codec, encoded)), value)
      }
    }
  })

  it("canonicalizes valid text the same way", () => {
    for (const source of ["bytes=000-004", "bytes=0-4,005-,-002"]) {
      const outputs = codecs.map((codec) => {
        const value = Result.getOrThrow(decode(codec, source))
        return Result.getOrThrow(encode(codec, value))
      })
      assert.equal(outputs[0], outputs[1])
    }
  })

  it("satisfies the value round-trip property for both codecs", () => {
    const range = FastCheck.oneof(
      FastCheck.record(
        {
          kind: FastCheck.constant("closed" as const),
          start: FastCheck.integer({ min: 0, max: 1_000 }),
          width: FastCheck.integer({ min: 0, max: 1_000 }),
        },
        { noNullPrototype: true },
      ).map(({ kind, start, width }) => ({ kind, start, end: start + width })),
      FastCheck.record(
        {
          kind: FastCheck.constant("open" as const),
          start: FastCheck.integer({ min: 0, max: 1_000 }),
        },
        { noNullPrototype: true },
      ),
      FastCheck.record(
        {
          kind: FastCheck.constant("suffix" as const),
          length: FastCheck.integer({ min: 1, max: 1_000 }),
        },
        { noNullPrototype: true },
      ),
    )
    const ranges = FastCheck.array(range, { minLength: 1, maxLength: 5 })

    FastCheck.assert(
      FastCheck.property(ranges, (value) => {
        const texts = codecs.map((codec) => Result.getOrThrow(encode(codec, value)))
        assert.equal(texts[0], texts[1])
        for (const codec of codecs) {
          assert.deepEqual(Result.getOrThrow(decode(codec, texts[0]!)), value)
        }
      }),
    )
  })

  it("satisfies the canonical-text property for both codecs", () => {
    const sources = FastCheck.array(rangeText, { minLength: 1, maxLength: 5 }).map(
      (ranges) => `bytes=${ranges.join(",")}`,
    )

    FastCheck.assert(
      FastCheck.property(sources, (source) => {
        const canonical = codecs.map((codec) => {
          const value = Result.getOrThrow(decode(codec, source))
          const text = Result.getOrThrow(encode(codec, value))
          const reparsed = Result.getOrThrow(decode(codec, text))
          assert.deepEqual(reparsed, value)
          return text
        })
        assert.equal(canonical[0], canonical[1])
      }),
    )
  })
})
