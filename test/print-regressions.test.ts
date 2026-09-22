import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"
import { printFail, printOk } from "./helpers.ts"

describe("printer sequencing and exception boundaries", () => {
  it.effect("stops wrappers and generators at the first failure and retains the failing value", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const tracked = (name: string) =>
        G.regex(/ok/, "ok").pipe(
          G.transform({
            decode: (value) => value,
            encode: (value: string) => {
              calls.push(name)
              return value
            },
          }),
        )
      const open = tracked("open").pipe(G.skip("bad"))
      const close = tracked("close").pipe(G.skip("ok"))
      const openFailure = printFail(tracked("inner").pipe(G.between(open, close)), "ok")
      assert.match(openFailure.message, /expected \/ok\/, got "bad"/)
      assert.doesNotMatch(openFailure.message, /not returned/)
      assert.deepEqual(calls, ["open"])

      calls.length = 0
      printFail(tracked("inner").pipe(G.between("(", close)), "bad")
      assert.deepEqual(calls, ["inner"])

      calls.length = 0
      const closeFailure = printFail(tracked("inner").pipe(G.between("(", tracked("close").pipe(G.skip("bad")))), "ok")
      assert.deepEqual(calls, ["inner", "close"])
      assert.match(closeFailure.message, /expected \/ok\/, got "bad"/)
      assert.doesNotMatch(closeFailure.message, /not returned/)

      calls.length = 0
      const grammar = G.gen(function*() {
        const first = yield* tracked("first")
        const second = yield* tracked("second")
        return { nested: { first }, second }
      })
      const error = printFail(grammar, { nested: { first: "bad" }, second: "ok" })
      assert.deepEqual(calls, ["first"])
      assert.equal(error.issue._tag, "AtPath")
      assert.match(error.message, /nested.*first/)
    }))

  it.effect("keeps syntax failures through omitted generators without resolving later suspensions", () =>
    Effect.sync(() => {
      const bad = G.regex(/ok/).pipe(G.skip("bad"))
      const syntax = G.seq(bad).pipe(G.between("[", "]"))
      assert.match(printFail(G.seq(syntax), undefined).message, /expected \/ok\/, got "bad"/)
      let calls = 0
      const later = G.suspend(() => {
        calls++
        return G.empty
      })
      const unresolved = G.empty.pipe(G.between(bad, later))
      assert.match(printFail(G.seq(unresolved), undefined).message, /expected \/ok\/, got "bad"/)
      assert.equal(calls, 0)
    }))

  it.effect("prints separators first and stops repeated items at the first failure", () =>
    Effect.sync(() => {
      const calls: Array<string> = []
      const item = G.regex(/ok/, "ok").pipe(
        G.transform({
          decode: (value) => value,
          encode: (value: string) => {
            calls.push(value)
            return value
          },
        }),
      )
      printFail(item.pipe(G.sepBy(item.pipe(G.skip("bad separator")))), ["ok"])
      assert.deepEqual(calls, ["bad separator"])
      for (const grammar of [item.pipe(G.many()), item.pipe(G.repeat(3))]) {
        calls.length = 0
        printFail(grammar, ["ok", "bad", "ok"])
        assert.deepEqual(calls, ["ok", "bad"])
      }
    }))

  it.effect("probes descriptors before reading fields in generators and structs", () =>
    Effect.sync(() => {
      const grammars: ReadonlyArray<G.Grammar<{ first: number; second: number }>> = [
        G.gen(function*() {
          const first = yield* G.integer
          const second = yield* G.integer
          return { first, second }
        }),
        G.struct({ first: G.integer, second: G.integer }),
      ]
      for (const grammar of grammars) {
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
        // Inspect printer reads only; the adjacent integers are intentionally ambiguous on parse.
        assert.equal(Result.getOrThrow(G.printUnchecked(grammar, value)), "12")
        assert.deepEqual(calls, ["keys", "descriptor:first", "descriptor:second", "get:first", "get:second"])
      }
    }))

  it.effect("catches descriptor traps before rejecting extra fields or reading getters", () =>
    Effect.sync(() => {
      const grammars: ReadonlyArray<G.Grammar<{ first: number; second: number }>> = [
        G.gen(function*() {
          const first = yield* G.integer
          const second = yield* G.integer
          return { first, second }
        }),
        G.struct({ first: G.integer, second: G.integer }),
      ]
      for (const grammar of grammars) {
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
    }))

  it.effect("preserves nested pattern paths and reads each getter only until the first failure", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
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
    }))

  it.effect("returns the same tag getter failure through transforms, suspensions, labels, and wrappers", () =>
    Effect.sync(() => {
      const thrown = new Error("tag getter failed")
      const value = {
        get kind(): "x" {
          throw thrown
        },
      }
      const grammar = G.dispatch("kind", [["x", G.literal("x").pipe(G.as({ kind: "x" as const }))]] as const)
      const transformed = grammar.pipe(G.transform({ decode: (value) => value, encode: (value) => value }))
      const issue: G.PrintIssue = {
        _tag: "AtPath",
        path: "kind",
        issue: { _tag: "InvalidValue", expected: "a readable field", actual: value, detail: "tag getter failed" },
      }
      for (
        const wrapped of [
          grammar,
          transformed,
          G.suspend(() => grammar),
          grammar.pipe(G.label("tagged")),
          grammar.pipe(G.between("[", "]")),
        ]
      ) {
        assert.deepEqual(printFail(wrapped, value).issue, issue)
        const unchecked = G.printUnchecked(wrapped, value)
        assert.ok(Result.isFailure(unchecked))
        assert.deepEqual(unchecked.failure.issue, issue)
      }
      const unresolved = G.suspend<string>(() => {
        throw new Error("resolution failed")
      })
      assert.match(printFail(unresolved, "x").message, /resolution failed/)
    }))

  it.effect("stops choice after success and checked printing before reparsing a failure", () =>
    Effect.sync(() => {
      let calls = 0
      const later = G.regex(/ok/, "ok").pipe(
        G.transform({
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
      assert.equal(printOk(G.choice([G.regex(/ok/, "ok"), later]), "ok"), "ok")
      assert.equal(calls, 0)
      G.print(later, "bad")
      assert.equal(calls, 1)
    }))
})
