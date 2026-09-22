import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"
import {
  assertParsePrintCanonical,
  assertPrintParse,
  Binary,
  checkCanonicalization,
  checkPrintParse,
} from "../src/testing.ts"
import { hashed, plain, wrong } from "./helpers.ts"

const canonical = G.integer.pipe(G.between(G.spaces, G.spaces))

describe("assertPrintParse", () => {
  it.effect("passes when the value round-trips", () =>
    Effect.sync(() => {
      assertPrintParse(G.integer, 42)
    }))

  it.effect("throws when print produces text that reads back differently", () =>
    Effect.sync(() => {
      assert.throws(() => assertPrintParse(G.choice([plain, hashed]), wrong), /reads back as/)
    }))
})

describe("assertParsePrintCanonical", () => {
  it.effect("returns the canonical form and drops unbound whitespace", () =>
    Effect.sync(() => {
      assert.equal(assertParsePrintCanonical(canonical, "\t 3\n"), " 3 ")
    }))

  it.effect("throws when the input does not parse", () =>
    Effect.sync(() => {
      assert.throws(() => assertParsePrintCanonical(G.integer, "nope"), /parse failed/)
    }))
})

describe("checkPrintParse", () => {
  it.effect("runs the round-trip law over an arbitrary of values", () =>
    Effect.sync(() => {
      checkPrintParse(G.integer, FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }))
    }))
})

describe("checkCanonicalization", () => {
  it.effect("runs the canonical law over an arbitrary of text", () =>
    Effect.sync(() => {
      const spaced = FastCheck.integer({ min: -50, max: 50 }).map((n) => `  ${n}\t`)
      checkCanonicalization(canonical, spaced)
    }))
})

describe("binary laws", () => {
  it.effect("canonicalizes noncanonical varuint bytes and compares byte contents", () =>
    Effect.sync(() => {
      assert.deepEqual(Binary.assertParsePrintCanonical(B.varuint, Uint8Array.of(0x81, 0)), Uint8Array.of(1))
      Binary.checkPrintParse(B.varuint, FastCheck.integer({ min: 0, max: 16383 }))
      Binary.checkCanonicalization(
        B.varuint,
        FastCheck.integer({ min: 0, max: 127 }).map((n) => Uint8Array.of(n | 0x80, 0)),
      )
    }))

  it.effect("reports lossy transforms and invalid input in hex", () =>
    Effect.sync(() => {
      const lossy = B.uint8.pipe(G.transform({ decode: (n) => n + 1, encode: (n: number) => n }))
      assert.throws(
        () => Binary.assertParsePrintCanonical(lossy, Uint8Array.of(0x0a)),
        /canonicalization changed the value[\s\S]*hex\[0a\][\s\S]*hex\[0b\]/,
      )
      assert.throws(() => Binary.assertPrintParse(lossy, 10), /hex\[0a\] reads back as 11/)
      assert.throws(() => Binary.assertParsePrintCanonical(B.uint16, Uint8Array.of(0xff)), /parse failed for hex\[ff\]/)
    }))

  it.effect("round-trips nested binary products with byte delimiters and neutral sides", () =>
    Effect.sync(() => {
      const nested = G.struct({
        entries: G.tuple(B.varuint, B.lengthPrefixed(B.uint8)).pipe(G.countPrefixed(B.uint8)),
        end: G.struct({ code: B.uint8.pipe(G.prefix(B.literal(0xaa)), G.suffix(G.empty)) }),
      })
      const value = { entries: [[1, Uint8Array.of(2, 3)]] as const, end: { code: 4 } }
      Binary.assertPrintParse(nested, value)
      assert.deepEqual(
        Binary.assertParsePrintCanonical(nested, Uint8Array.of(1, 0x81, 0, 2, 2, 3, 0xaa, 4)),
        Uint8Array.of(1, 1, 2, 2, 3, 0xaa, 4),
      )
    }))
})
