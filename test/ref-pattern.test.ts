import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import * as G from "../src/index.ts"
import { parseOk, printFail, printOk } from "./helpers.ts"

describe("opaque refs and return patterns", () => {
  const header = G.struct({
    layout: G.struct({
      kind: G.literals("text", "bits").pipe(G.suffix("/")),
      size: G.integer.pipe(G.suffix(":")),
    }),
  })

  it.effect("evaluates nested get for match, take, and repeat in both directions", () =>
    Effect.sync(() => {
      const grammar = G.gen(function* () {
        const h = yield* G.choice([header, header])
        const layout = G.get(h, "layout")
        const size = G.get(layout, "size")
        const body = yield* G.match(G.get(layout, "kind"), [
          ["text", G.take(size)],
          ["bits", G.regex(/[01]/, "bit").pipe(G.repeat(size))],
        ] as const)
        return { packet: { header: h }, body }
      })

      assert.deepEqual(G.diagnose(grammar), [])
      for (const text of ["text/3:abc", "bits/2:01"]) {
        assert.equal(printOk(grammar, parseOk(grammar, text)), text)
      }
      assert.deepEqual(parseOk(grammar, "text/3:abc"), {
        packet: { header: { layout: { kind: "text", size: 3 } } },
        body: "abc",
      })
      assert.match(G.render(grammar), /match\(packet\.header\.layout\.kind\)/)
      assert.match(G.render(grammar), /<take>\{packet\.header\.layout\.size\}/)
      assert.match(
        printFail(grammar, {
          packet: { header: { layout: { kind: "text", size: 3 } } },
          body: "ab",
        }).message,
        /^\.body: expected 3 characters/,
      )
    }),
  )

  it.effect("evaluates explicit array indexes and length", () =>
    Effect.sync(() => {
      const grammar = G.gen(function* () {
        const counts = yield* G.tuple(G.integer.pipe(G.suffix(":")))
        const body = yield* G.take(G.get(counts, 0))
        const tail = yield* G.regex(/[01]/).pipe(G.repeat(G.get(counts, "length")))
        return { counts, body, tail }
      })
      const value: G.Type<typeof grammar> = { counts: [2], body: "ab", tail: ["1"] }
      assert.deepEqual(parseOk(grammar, "2:ab1"), value)
      assert.equal(printOk(grammar, value), "2:ab1")
    }),
  )

  it.effect("keeps parent and local refs through nested wrapper sequences", () =>
    Effect.sync(() => {
      const grammar = G.gen(function* () {
        const header = yield* G.struct({ size: G.integer.pipe(G.suffix(":")) })
        const size = G.get(header, "size")
        const body = yield* G.gen(function* () {
          const count = yield* G.integer.pipe(G.suffix(":"))
          const value = yield* G.take(size).pipe(
            G.between(G.take(count).pipe(G.skip("!")), G.take(size).pipe(G.skip("??"))),
          )
          return { count, value }
        }).pipe(G.between("<", ">"), G.prefix("#"), G.suffix(";"))
        return { header, body }
      })
      const value = { header: { size: 2 }, body: { count: 1, value: "xy" } }
      assert.deepEqual(G.diagnose(grammar), [])
      assert.deepEqual(parseOk(grammar, "2:#<1:!xy??>;"), value)
      assert.equal(printOk(grammar, value), "2:#<1:!xy??>;")
      assert.match(G.render(grammar), /<take>\{header\.size\}/)
      assert.match(G.render(grammar), /<take>\{count\}/)
      assert.match(printFail(grammar, { ...value, body: { count: 1, value: "x" } }).message, /^\.body\.value:/)
      const syntaxFailure = printFail(grammar, { ...value, body: { count: 2, value: "xy" } })
      assert.match(syntaxFailure.message, /^\.body\.value: expected 2 characters, got "!"/)
      assert.doesNotMatch(syntaxFailure.message, /not returned/)
    }),
  )

  it.effect("rejects nested property refs anywhere in a return pattern", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function* () {
            const h = yield* header
            return { nested: [G.get(G.get(h, "layout"), "size")] }
          }),
        /property ref; return the whole bound ref/,
      )
    }),
  )

  it.effect("rejects enumeration and coercion without exposing ref state", () =>
    Effect.sync(() => {
      G.gen(function* () {
        const h = yield* header
        assert.equal(Object.getOwnPropertyDescriptor(h, "expr"), undefined)
        assert.equal(Object.getOwnPropertyDescriptor(h, "scope"), undefined)
        assert.throws(() => Object.keys(h), /cannot be spread or enumerated/)
        assert.throws(() => JSON.stringify(h), /cannot be spread or enumerated/)
        assert.throws(() => Number(h), /Grammar\.Ref has no value/)
        // oxlint-disable-next-line typescript/no-base-to-string -- Deliberately exercise coercion rejection.
        assert.throws(() => String(h), /Grammar\.Ref has no value/)
        assert.throws(() => h.valueOf(), /Grammar\.Ref has no value/)
        return h
      })
    }),
  )
})
