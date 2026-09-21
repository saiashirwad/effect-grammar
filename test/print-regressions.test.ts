import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"

import * as G from "../src/index.ts"
import { printFail, printOk } from "./helpers.ts"

describe("printer sequencing and exception boundaries", () => {
  it.effect("stops wraps and generators at the first failure", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const tracked = (name: string) =>
        G.regex(/ok/, "ok").pipe(
          G.iso({
            decode: (value) => value,
            encode: (value: string) => {
              calls.push(name)
              return value
            },
          }),
        )
      const open = tracked("open").pipe(G.skip("bad"))
      const close = tracked("close").pipe(G.skip("ok"))
      printFail(G.between(open, tracked("inner"), close), "ok")
      assert.deepEqual(calls, ["open"])

      calls.length = 0
      printFail(G.between("(", tracked("inner"), close), "bad")
      assert.deepEqual(calls, ["inner"])

      calls.length = 0
      const grammar = G.gen(function* () {
        const first = yield* tracked("first")
        const second = yield* tracked("second")
        return { nested: { first }, second }
      })
      const error = printFail(grammar, { nested: { first: "bad" }, second: "ok" })
      assert.deepEqual(calls, ["first"])
      assert.equal(error.issue._tag, "AtPath")
      assert.match(error.message, /nested.*first/)
    }),
  )

  it.effect("prints separators first and stops repeated items at the first failure", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const item = G.regex(/ok/, "ok").pipe(
        G.iso({
          decode: (value) => value,
          encode: (value: string) => {
            calls.push(value)
            return value
          },
        }),
      )
      printFail(G.sepBy(item, item.pipe(G.skip("bad separator"))), ["ok"])
      assert.deepEqual(calls, ["bad separator"])
      for (const grammar of [G.many(item), G.repeat(item, 3)]) {
        calls.length = 0
        printFail(grammar, ["ok", "bad", "ok"])
        assert.deepEqual(calls, ["ok", "bad"])
      }
    }),
  )

  it.effect("does not inspect later merge fields after a failure", () =>
    Effect.sync(() => {
      const grammar = G.merge(G.struct({ first: G.integer }), G.struct({ second: G.integer }))
      let reads = 0
      const value = {
        first: Number.NaN,
        get second(): number {
          reads++
          throw new Error("later field")
        },
      }
      printFail(grammar, value)
      assert.equal(reads, 0)
      const error = printFail(grammar, {
        first: 1,
        get second(): number {
          throw new Error("field failed")
        },
      })
      assert.match(error.message, /field failed/)
    }),
  )

  it.effect("probes descriptors before reading fields in generators and merges", () =>
    Effect.sync(() => {
      for (const [index, grammar] of [
        G.struct({ first: G.integer, second: G.integer }),
        G.merge(G.struct({ first: G.integer }), G.struct({ second: G.integer })),
      ].entries()) {
        const calls: Array<string> = []
        const value = new Proxy(
          { first: 1, second: 2 },
          {
            ownKeys: (target) => {
              calls.push("keys")
              return Reflect.ownKeys(target)
            },
            getOwnPropertyDescriptor: (target, key) => {
              calls.push(`descriptor:${String(key)}`)
              return Object.getOwnPropertyDescriptor(target, key)
            },
            get: (target, key) => {
              calls.push(`get:${String(key)}`)
              if (key === "first" || key === "second") return target[key]
              return undefined
            },
          },
        )
        assert.equal(printOk(grammar, value), "12")
        assert.deepEqual(calls, [
          "keys",
          "descriptor:first",
          "descriptor:second",
          ...(index === 1 ? ["descriptor:first"] : []),
          "get:first",
          ...(index === 1 ? ["descriptor:second"] : []),
          "get:second",
        ])
      }
    }),
  )

  it.effect("catches descriptor traps before rejecting extra fields or reading getters", () =>
    Effect.sync(() => {
      for (const grammar of [
        G.struct({ first: G.integer, second: G.integer }),
        G.merge(G.struct({ first: G.integer }), G.struct({ second: G.integer })),
      ]) {
        const calls: Array<string> = []
        const value = new Proxy(
          { extra: true, first: 1, second: 2 },
          {
            ownKeys: (target) => {
              calls.push("keys")
              return Reflect.ownKeys(target)
            },
            getOwnPropertyDescriptor: (target, key) => {
              calls.push(`descriptor:${String(key)}`)
              if (key === "first") throw new Error("descriptor failed")
              return Object.getOwnPropertyDescriptor(target, key)
            },
            get: (target, key) => {
              calls.push(`get:${String(key)}`)
              if (key === "first" || key === "second") return target[key]
              return undefined
            },
          },
        )
        const error = printFail(grammar, value)
        assert.deepEqual(error.issue, {
          _tag: "InvalidValue",
          expected: "an inspectable object with exactly the fields first, second",
          actual: value,
          detail: "could not inspect own fields: descriptor failed",
        })
        assert.deepEqual(calls, ["keys", "descriptor:extra", "descriptor:first"])
      }
    }),
  )

  it.effect(
    "preserves nested pattern paths and reads each getter only until the first failure",
    () =>
      Effect.sync(() => {
        const grammar = G.gen(function* () {
          const tail = yield* G.integer
          return { nested: [{ kind: "ok" as const }], tail }
        })
        const calls: Array<string> = []
        const value = {
          get nested() {
            calls.push("nested")
            return [
              {
                get kind() {
                  calls.push("kind")
                  return "bad" as const
                },
              },
            ]
          },
          get tail() {
            calls.push("tail")
            return 1
          },
        }
        // SAFETY: deliberately mismatched constant exercises pattern validation.
        const error = printFail(grammar, value as never)
        assert.deepEqual(error.issue, {
          _tag: "AtPath",
          path: "nested",
          issue: {
            _tag: "AtPath",
            path: 0,
            issue: {
              _tag: "AtPath",
              path: "kind",
              issue: { _tag: "ConstantMismatch", expected: "ok", actual: "bad" },
            },
          },
        })
        assert.deepEqual(calls, ["nested", "kind"])

        calls.length = 0
        const item = {
          get kind(): "ok" {
            calls.push("kind")
            throw new Error("getter failed")
          },
        }
        const unreadable = {
          get nested() {
            calls.push("nested")
            return [item]
          },
          get tail() {
            calls.push("tail")
            return 1
          },
        }
        assert.deepEqual(printFail(grammar, unreadable).issue, {
          _tag: "AtPath",
          path: "nested",
          issue: {
            _tag: "AtPath",
            path: 0,
            issue: {
              _tag: "AtPath",
              path: "kind",
              issue: {
                _tag: "InvalidValue",
                expected: "a readable field",
                actual: item,
                detail: "getter failed",
              },
            },
          },
        })
        assert.deepEqual(calls, ["nested", "kind"])
      }),
  )

  it.effect("keeps transform catches broad and suspend catches limited to resolution", () =>
    Effect.sync(() => {
      const thrown = new Error("tag getter failed")
      const value = {
        get kind(): "x" {
          throw thrown
        },
      }
      const grammar = G.choiceOn("kind", { x: G.literal("x").pipe(G.as({ kind: "x" as const })) })
      assert.throws(
        () => G.print(grammar, value),
        (error) => error === thrown,
      )
      assert.throws(
        () =>
          G.print(
            G.suspend(() => grammar),
            value,
          ),
        (error) => error === thrown,
      )
      const transformed = grammar.pipe(
        G.iso({ decode: (value) => value, encode: (value) => value }),
      )
      assert.match(printFail(transformed, value).message, /tag getter failed/)
      const unresolved = G.suspend<string>(() => {
        throw new Error("resolution failed")
      })
      assert.match(printFail(unresolved, "x").message, /resolution failed/)
    }),
  )

  it.effect("stops choice after success and checked printing before reparsing a failure", () =>
    Effect.sync(() => {
      let calls = 0
      const later = G.regex(/ok/, "ok").pipe(
        G.iso({
          decode: (value) => {
            calls++
            return value
          },
          encode: (value: string) => {
            calls++
            return value
          },
        }),
      )
      assert.equal(printOk(G.choice(G.regex(/ok/, "ok"), later), "ok"), "ok")
      assert.equal(calls, 0)
      G.printChecked(later, "bad")
      assert.equal(calls, 1)
    }),
  )
})
