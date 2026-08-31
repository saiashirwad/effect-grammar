import assert from "node:assert/strict"

import { Result } from "effect"
import { describe, it } from "vitest"

import * as G from "../src/index.ts"

const word = G.regex(/[a-z]+/, "word")

describe("validate", () => {
  it("passes a sound grammar", () => {
    const g = G.gen(function* () {
      const length = yield* G.integer
      yield* G.literal(":")
      const payload = yield* G.take(length)
      return { length, payload }
    })
    assert.deepEqual(G.validate(g), [])
  })

  it("catches a ref used outside the gen that bound it", () => {
    let escaped: G.Grammar<string> | undefined
    G.gen(function* () {
      const length = yield* G.integer
      escaped = G.take(length)
      return length
    })
    if (escaped === undefined) assert.fail("expected escaped grammar")
    const issues = G.validate(escaped)
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
  })

  it("catches unbounded repetition of an empty-matching grammar", () => {
    const issues = G.validate(G.many(G.regex(/x*/, "xs")))
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.message, /can match the empty string/)
  })

  it("catches duplicate match keys", () => {
    const selector = G.choice(G.literal("a").pipe(G.as(1)), G.literal("b").pipe(G.as(2)))
    const g = G.gen(function* () {
      const kind = yield* selector
      const value = yield* G.matchValue(kind, [
        [1, G.integer],
        [1, G.integer],
        [2, G.integer],
      ] as const)
      return { kind, value }
    })
    const issues = G.validate(g)
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.message, /duplicate case key 1/)
  })
})

describe("compile", () => {
  it("returns prepared operations for a sound grammar", () => {
    const g = G.struct({ host: word, port: G.integer.pipe(G.prefix(":")) })
    const compiled = G.compile(g)
    assert.deepEqual(Result.getOrThrow(compiled.parse("h:80")), { host: "h", port: 80 })
    assert.equal(Result.getOrThrow(compiled.print({ host: "h", port: 80 })), "h:80")
    assert.equal(Result.getOrThrow(compiled.printChecked({ host: "h", port: 80 })), "h:80")
    assert.equal(compiled.render, 'host:<word> port:(":" <integer>)')
  })

  it("throws on an invalid grammar", () => {
    let escaped: G.Grammar<string> | undefined
    G.gen(function* () {
      const length = yield* G.integer
      escaped = G.take(length)
      return length
    })
    assert.throws(() => G.compile(escaped!), /the grammar has 1 issue/)
  })
})

describe("auditFidelity", () => {
  it("is empty for grammars built from isos", () => {
    assert.deepEqual(G.auditFidelity(G.integer), [])
  })

  it("lists transforms that claim no inverse law", () => {
    const g = G.regex(/\d+/, "d").pipe(G.transform({ decode: Number, encode: String, name: "num" }))
    assert.deepEqual(G.auditFidelity(g), [{ name: "num", fidelity: "unchecked" }])
  })

  it("reports partialIso as partial", () => {
    const g = G.regex(/\d+/, "d").pipe(
      G.partialIso({
        decode: (raw) => Result.succeed(Number(raw)),
        encode: (n) => Result.succeed(String(n)),
        name: "p",
      }),
    )
    assert.deepEqual(G.auditFidelity(g), [{ name: "p", fidelity: "partial" }])
  })
})
