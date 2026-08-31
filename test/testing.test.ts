import assert from "node:assert/strict"

import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"

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
  it("passes when the value round-trips", () => {
    assertPrintParse(G.integer, 42)
  })

  it("throws when print produces text that reads back differently", () => {
    assert.throws(() => assertPrintParse(G.choice(plain, hashed), wrong), /reads back as/)
  })
})

describe("assertParsePrintCanonical", () => {
  it("returns the canonical form and drops unbound whitespace", () => {
    assert.equal(assertParsePrintCanonical(canonical, "\t 3\n"), " 3 ")
  })

  it("throws when the input does not parse", () => {
    assert.throws(() => assertParsePrintCanonical(G.integer, "nope"), /parse failed/)
  })
})

describe("checkPrintParse", () => {
  it("runs the round-trip law over an arbitrary of values", () => {
    checkPrintParse(
      G.integer,
      FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    )
  })
})

describe("checkCanonicalization", () => {
  it("runs the canonical law over an arbitrary of text", () => {
    const spaced = FastCheck.integer({ min: -50, max: 50 }).map((n) => `  ${n}\t`)
    checkCanonicalization(canonical, spaced)
  })
})
