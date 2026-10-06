import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"
import { assertRoundTrip, parseFail, parseOk, printFail, printOk } from "./helpers.ts"

const word = G.regex(/[a-z]+/, "word")

describe("generator binding order", () => {
  it.effect("binds in return-shape order before running printers in yield order", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const first = G.integer.pipe(G.transform({
        decode: (value) => value,
        encode: (value: number) => {
          calls.push("encode first")
          return value
        },
      }))
      const grammar = G.gen(function*() {
        const a = yield* first.pipe(G.suffix(":"))
        const b = yield* G.integer
        return { b, nested: { a }, empty: [] }
      })
      assert.equal(
        Result.getOrThrow(G.printUnchecked(grammar, {
          get b() {
            calls.push("read b")
            return 2
          },
          nested: {
            get a() {
              calls.push("read a")
              return 1
            },
          },
          empty: [],
        })),
        "1:2",
      )
      assert.deepEqual(calls, ["read b", "read a", "encode first"])
    }))

  it.effect("stops binding at a throwing getter before executing any printer", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const grammar = G.gen(function*() {
        const first = yield* G.integer.pipe(G.transform({
          decode: (value) => value,
          encode: (value: number) => {
            calls.push("encode")
            return value
          },
        }))
        const second = yield* G.integer
        return { second, first }
      })
      const printed = G.printUnchecked(grammar, {
        get second(): number {
          calls.push("read second")
          throw new Error("unreadable")
        },
        get first() {
          calls.push("read first")
          return 1
        },
      })
      assert.ok(Result.isFailure(printed))
      assert.match(printed.failure.message, /^\.second:/)
      assert.deepEqual(calls, ["read second"])
    }))

  it.effect("builds once and keeps sibling dependent frames isolated across runs", () =>
    Effect.sync(() => {
      let builds = 0
      const item = G.gen(function*() {
        builds++
        const size = yield* G.integer.pipe(G.suffix(":"))
        const value = yield* G.take(size)
        return { nested: [value], size }
      })
      const grammar = item.pipe(G.sepBy(";"))
      for (const input of ["1:a;2:bc", "3:def;1:g", "0:;2:hi"]) {
        const value = parseOk(grammar, input)
        assert.equal(printOk(grammar, value), input)
      }
      assert.equal(builds, 1)
    }))
})

describe("generator scopes and return shapes", () => {
  it.effect("keeps sibling gens' slots isolated", () =>
    Effect.sync(() => {
      const inner = G.gen(function*() {
        const a = yield* G.integer
        yield* G.literal("+")
        const b = yield* G.integer
        return { a, b }
      })
      const outer = G.gen(function*() {
        const first = yield* inner
        yield* G.literal(";")
        const second = yield* inner
        return { first, second }
      })

      assert.deepEqual(parseOk(outer, "1+2;3+4"), {
        first: { a: 1, b: 2 },
        second: { a: 3, b: 4 },
      })
      assert.equal(printOk(outer, { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } }), "1+2;3+4")
    }))

  it.effect("fails a grammar whose ref escaped its gen, at use time", () =>
    Effect.sync(() => {
      let escaped: G.Grammar<string> | undefined

      G.gen(function*() {
        const length = yield* G.integer
        escaped = G.take(length)
        return length
      })

      if (escaped === undefined) assert.fail("expected escaped grammar")
      const grammar = escaped
      assert.deepEqual(parseFail(grammar, "abc").expected, ["a bound take count"])
      const printed = G.print(grammar, "abc")
      assert.ok(Result.isFailure(printed))
    }))

  it.effect("distinguishes an absent field from present undefined", () =>
    Effect.sync(() => {
      interface OptionalField {
        readonly field?: undefined
      }

      const grammar = G.gen(function*() {
        yield* G.literal("x")
        const value: OptionalField = { field: undefined }
        return value
      })

      assert.match(printFail(grammar, {}).message, /\.field: missing field/)
      assert.equal(printOk(grammar, { field: undefined }), "x")
    }))

  it.effect("rejects cyclic output patterns", () =>
    Effect.sync(() => {
      interface Cycle {
        self?: Cycle
      }

      const value: Cycle = {}
      value.self = value

      assert.throws(
        () =>
          G.gen(function*() {
            yield* G.literal("x")
            return value
          }),
        /cyclic/,
      )
    }))

  /* eslint-disable unicorn/no-thenable -- Reserved then properties are the behavior under test. */
  it.effect("accesses reserved ref properties through get", () =>
    Effect.sync(() => {
      const headerGrammar = G.literal("h").pipe(G.as({ then: "number" as const }))
      const grammar = G.gen(function*() {
        const header = yield* headerGrammar
        const value = yield* G.match(G.get(header, "then"), [["number", G.integer]] as const)
        return { header, value }
      })

      assert.deepEqual(parseOk(grammar, "h12"), { header: { then: "number" }, value: 12 })
      const output: G.Type<typeof grammar> = { header: { then: "number" }, value: 3 }
      assert.equal(printOk(grammar, output), "h3")
    }))
  /* eslint-enable unicorn/no-thenable */

  it.effect("keeps structured print paths", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const port = yield* G.integer
        return { address: { port } }
      })

      const error = printFail(grammar, { address: { port: 1.5 } })
      assert.match(error.message, /^\.address\.port: expected integer/)
      assert.equal(error.issue._tag, "AtPath")
    }))

  it.effect("a gen inside a gen keeps its own bindings, and a failed inner gen backtracks", () =>
    Effect.sync(() => {
      const pair = G.gen(function*() {
        const a = yield* G.integer
        yield* G.literal("=")
        const b = yield* G.integer
        return { a, b }
      })
      const g = G.gen(function*() {
        const first = yield* G.choice([pair, G.integer])
        yield* G.literal(";")
        const second = yield* pair
        return { first, second }
      })
      assert.deepEqual(parseOk(g, "1;2=3"), { first: 1, second: { a: 2, b: 3 } })
      assert.deepEqual(parseOk(g, "1=2;3=4"), { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } })
    }))

  it.effect("keeps a computed __proto__ return field as an own property", () =>
    Effect.sync(() => {
      const inner = G.gen(function*() {
        const value = yield* G.integer
        return { value }
      })
      const key = "__proto__"
      const grammar = G.gen(function*() {
        const value = yield* inner
        return { [key]: value }
      })

      const result = parseOk(grammar, "1")
      assert.equal(Object.hasOwn(result, key), true)
      assert.equal(Object.getPrototypeOf(result), Object.prototype)
      assert.equal(Object.getOwnPropertyDescriptor(result, key)?.enumerable, true)
      assert.deepEqual(result[key], { value: 1 })
      assert.equal(printOk(grammar, result), "1")
    }))

  it.effect("prints object patterns exactly", () =>
    Effect.sync(() => {
      const grammar = G.struct({ value: G.integer })
      const extra = { value: 1, extra: true }
      assert.match(printFail(grammar, extra).message, /unexpected own field/)
    }))
})

describe("whole-ref composition", () => {
  const point = G.gen(function*() {
    const x = yield* G.integer
    const y = yield* G.integer.pipe(G.prefix(","))
    return { x, y }
  })

  it.effect("flattens whole values with an explicit transform", () =>
    Effect.sync(() => {
      const named = G.gen(function*() {
        const p = yield* point.pipe(
          G.filter((value: G.Type<typeof point>) => value.x >= 0, "a point right of the origin"),
        )
        const name = yield* word.pipe(G.prefix(";"))
        return { p, name }
      }).pipe(
        G.transform({
          decode: ({ p, name }) => ({ ...p, name }),
          encode: ({ name, ...p }) => ({ p, name }),
        }),
      )
      assert.deepEqual(parseOk(named, "1,2;p"), { x: 1, y: 2, name: "p" })
      assertRoundTrip(named, { x: 3, y: -4, name: "q" })
    }))

  it.effect("composes whole refs through wrappers without shape discovery", () =>
    Effect.sync(() => {
      const wrappers = [
        point,
        point.pipe(G.label("point")),
        point.pipe(G.filter((p: G.Type<typeof point>) => p.x >= 0, "positive x")),
        point.pipe(G.transform({ decode: (p) => p, encode: (p) => p })),
        G.choice([point, point]),
        G.suspend(() => point),
      ]
      for (const wrapped of wrappers) {
        const composed = G.gen(function*() {
          const p = yield* wrapped.pipe(G.between("(", ")"))
          return { nested: [p] as const }
        })
        assert.deepEqual(G.diagnose(composed), [])
        assert.deepEqual(parseOk(composed, "(1,2)"), { nested: [{ x: 1, y: 2 }] })
        const value: G.Type<typeof composed> = { nested: [{ x: 3, y: 4 }] }
        assertRoundTrip(composed, value)
        const invalid: G.Type<typeof composed> = { nested: [{ x: 1.5, y: 2 }] }
        const message = printFail(composed, invalid).message
        assert.match(message, /^\.nested\[0\]/)
        assert.match(message, /\.x: expected integer/)
      }
    }))

  it.effect("reports print failures by flat field path", () =>
    Effect.sync(() => {
      // SAFETY: deliberately omitting y to show the printer reports the flat path.
      const missing = { x: 1 } as G.Type<typeof point>
      assert.match(printFail(point, missing).message, /^\.y: missing field/)
      const extra = { x: 1, y: 2, z: 3 }
      assert.match(printFail(point, extra).message, /unexpected own field/)
    }))

  it.effect("rejects spreads, duplicate whole refs, and property returns", () =>
    Effect.sync(() => {
      assert.throws(
        () =>
          G.gen(function*() {
            const p = yield* point
            return { x: G.get(p, "x"), y: G.get(p, "y") }
          }),
        /property ref/,
      )
      assert.throws(
        () =>
          G.gen(function*() {
            const p = yield* point
            return { p, again: p }
          }),
        /returned twice/,
      )
      assert.throws(
        () =>
          G.gen(function*() {
            const p = yield* point
            // oxlint-disable-next-line typescript/no-misused-spread -- Deliberately exercise runtime rejection.
            return { ...p }
          }),
        /cannot be spread or enumerated/,
      )
      const wrapped = word.pipe(G.transform({ decode: (w) => ({ w }), encode: ({ w }) => w }))
      assert.throws(
        () =>
          G.gen(function*() {
            const w = yield* wrapped
            return { first: G.get(w, "w") }
          }),
        /property ref/,
      )
    }))
})
