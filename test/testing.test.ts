import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import * as G from "../src/index.ts"
import {
  assertParsePrintCanonical,
  assertPrintParse,
  checkCanonicalization,
  checkPrintParse,
} from "../src/testing.ts"
import { hashed, plain, wrong } from "./helpers.ts"

const canonical = G.between(G.spaces, G.integer, G.spaces)

describe("assertPrintParse", () => {
  it.effect("passes when the value round-trips", () =>
    Effect.sync(() => {
      assertPrintParse(G.integer, 42)
    }),
  )

  it.effect("throws when print produces text that reads back differently", () =>
    Effect.sync(() => {
      assert.throws(() => assertPrintParse(G.choice(plain, hashed), wrong), /reads back as/)
    }),
  )
})

describe("assertParsePrintCanonical", () => {
  it.effect("returns the canonical form and drops unbound whitespace", () =>
    Effect.sync(() => {
      assert.equal(assertParsePrintCanonical(canonical, "\t 3\n"), " 3 ")
    }),
  )

  it.effect("throws when the input does not parse", () =>
    Effect.sync(() => {
      assert.throws(() => assertParsePrintCanonical(G.integer, "nope"), /parse failed/)
    }),
  )
})

describe("checkPrintParse", () => {
  it.effect("runs the round-trip law over an arbitrary of values", () =>
    Effect.sync(() => {
      checkPrintParse(
        G.integer,
        FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
      )
    }),
  )
})

describe("checkCanonicalization", () => {
  it.effect("runs the canonical law over an arbitrary of text", () =>
    Effect.sync(() => {
      const spaced = FastCheck.integer({ min: -50, max: 50 }).map((n) => `  ${n}\t`)
      checkCanonicalization(canonical, spaced)
    }),
  )
})
