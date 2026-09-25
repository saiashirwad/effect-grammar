import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import * as G from "../src/index.ts"

const word = G.regex(/[a-z]+/, "word")

const escaped = (() => {
  let leaked: G.Grammar<string> | undefined
  G.gen(function*() {
    const length = yield* G.integer
    leaked = G.take(length)
    return length
  })
  return leaked!
})()

describe("diagnose", () => {
  it.effect("passes a sound grammar", () =>
    Effect.sync(() => {
      const g = G.gen(function*() {
        const length = yield* G.integer
        yield* G.literal(":")
        const payload = yield* G.take(length)
        return { length, payload }
      })
      assert.deepEqual(G.diagnose(g), [])
    }))

  it.effect("catches a ref used outside the gen that bound it", () =>
    Effect.sync(() => {
      const issues = G.diagnose(escaped)
      assert.equal(issues.length, 1)
      assert.equal(issues[0]!._tag, "OutOfScopeRef")
      assert.deepEqual(issues[0]!.path, ["count"])
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
    }))

  it.effect("catches unbounded repetition of an empty-matching grammar", () =>
    Effect.sync(() => {
      const issues = G.diagnose(G.regex(/x*/, "xs").pipe(G.many()))
      assert.equal(issues.length, 1)
      assert.equal(issues[0]!._tag, "EmptyRepetition")
      assert.deepEqual(issues[0]!.path, ["inner"])
      assert.match(issues[0]!.message, /can match the empty string/)
      assert.match(G.diagnose(G.literal("").pipe(G.many()))[0]!.message, /can match the empty string/)
    }))

  it.effect("rejects bounded repetition of an empty item too", () =>
    Effect.sync(() => {
      const grammar = G.empty.pipe(G.many({ min: 1, max: 2 }))

      const issues = G.diagnose(grammar)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /zero-width elements/)
    }))

  it.effect("checks the item of a repeat unless its constant count is zero", () =>
    Effect.sync(() => {
      const item = G.optional(G.literal("a"))
      assert.match(G.diagnose(item.pipe(G.repeat(2)))[0]!.message, /zero-width elements/)
      assert.match(G.diagnose(item.pipe(G.countPrefixed(G.integer)))[0]!.message, /zero-width elements/)
      assert.deepEqual(G.diagnose(item.pipe(G.repeat(0))), [])
    }))

  it.effect("sees through a transform that cannot match empty, and through a constant", () =>
    Effect.sync(() => {
      assert.match(G.diagnose(G.integer.pipe(G.many(), G.many()))[0]!.message, /zero-width elements/)
      assert.match(G.diagnose(G.literals("", "a").pipe(G.many()))[0]!.message, /zero-width elements/)
      assert.match(G.diagnose(G.flag("-").pipe(G.many()))[0]!.message, /zero-width elements/)
      assert.deepEqual(G.diagnose(G.literals("a", "b").pipe(G.many())), [])
    }))

  it.effect("detects that a zero-maximum repetition always matches empty", () =>
    Effect.sync(() => {
      const inner = G.empty.pipe(G.many({ max: 0 }))
      const outer = inner.pipe(G.many())

      const issues = G.diagnose(outer)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /can match the empty string/)
    }))

  it.effect("does not claim a fallible transform matches empty", () =>
    Effect.sync(() => {
      const nonempty = G.regex(/x*/, "xs").pipe(
        G.transformOrFail({
          decode: (value) => (value === "" ? Result.fail("at least one x") : Result.succeed(value)),
          encode: Result.succeed,
        }),
      )
      const grammar = nonempty.pipe(G.label("nonempty xs"), G.many())

      assert.deepEqual(G.diagnose(grammar), [])
      assert.deepEqual(Result.getOrThrow(G.parse(grammar, "xx")), ["xx"])
    }))

  it.effect("leaves an empty-producing transform to the runtime progress check", () =>
    Effect.sync(() => {
      const empty = G.regex(/x*/, "xs").pipe(
        G.transform({
          decode: () => "x",
          encode: () => "",
        }),
        G.skip(""),
      )
      const grammar = empty.pipe(G.many())

      assert.deepEqual(G.diagnose(grammar), [])
      const parsed = G.parse(grammar, "")
      assert.equal(Result.isFailure(parsed), true)
      if (Result.isFailure(parsed)) assert.match(parsed.failure.message, /consumes input/)
    }))

  it.effect("diagnoses a delayed grammar in each ref scope where it is used", () =>
    Effect.sync(() => {
      let delayed: G.Grammar<string> | undefined
      const owner = G.gen(function*() {
        const length = yield* G.integer
        const dependent = G.gen(function*() {
          const payload = yield* G.take(length)
          return payload
        })
        delayed = G.suspend(() => dependent)
        const payload = yield* delayed
        return { length, payload }
      })

      const grammar = G.choice([owner, delayed!])
      const issues = G.diagnose(grammar)
      assert.equal(issues.length, 1)
      assert.deepEqual(issues[0]!.path, ["options", 1, "resolved", "steps", 0, "count"])
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
    }))

  it.effect("reports one issue when a delayed grammar repeats in one ref scope", () =>
    Effect.sync(() => {
      let delayed: G.Grammar<string> | undefined
      G.gen(function*() {
        const length = yield* G.integer
        const dependent = G.gen(function*() {
          const payload = yield* G.take(length)
          return payload
        })
        delayed = G.suspend(() => dependent)
        return length
      })

      assert.equal(G.diagnose(G.choice([delayed!, delayed!])).length, 1)
    }))

  it.effect("has nothing to report for duplicate match keys, which match rejects on construction", () =>
    Effect.sync(() => {
      const selector = G.choice([G.literal("a").pipe(G.as(1)), G.literal("b").pipe(G.as(2))])
      assert.throws(
        () =>
          G.gen(function*() {
            const kind = yield* selector
            const value = yield* G.match(
              kind,
              [
                [1, G.integer],
                [1, G.integer],
                [2, G.integer],
              ] as const,
            )
            return { kind, value }
          }),
        /match: duplicate key 1/,
      )
    }))

  it.effect("reports a step that is parsed but not returned", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        yield* word
        yield* G.literal(":")
        const port = yield* G.integer
        return { port }
      })

      const issues = G.diagnose(grammar)
      assert.equal(issues.length, 1)
      assert.equal(issues[0]!._tag, "OmittedValue")
      assert.deepEqual(issues[0]!.path, ["steps", 0])
      assert.match(issues[0]!.message, /gen: step 1 \(word\) is parsed but not returned/)
    }))

  it.effect("accepts an omitted dependent skip without evaluating its ref", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const length = yield* G.integer.pipe(G.suffix(":"))
        yield* G.take(length).pipe(G.skip("abc"))
        return length
      })

      assert.deepEqual(G.diagnose(grammar), [])
      assert.equal(Result.getOrThrow(G.parse(grammar, "3:abc")), 3)
      assert.equal(Result.getOrThrow(G.print(grammar, 3)), "3:abc")
    }))

  it.effect("never probes encode, decode, or predicates, even for undefined outputs", () =>
    Effect.sync(() => {
      const calls = { encode: 0, decode: 0, predicate: 0 }
      const opaque = G.empty.pipe(
        G.transform<void, void>({
          decode: () => {
            calls.decode++
          },
          encode: () => {
            calls.encode++
          },
        }),
      )
      const filtered = G.empty.pipe(
        G.filter<void>(() => {
          calls.predicate++
          return true
        }, "accepts undefined"),
      )
      const omitted = G.seq(opaque, filtered)
      assert.deepEqual(
        G.diagnose(omitted).map(({ _tag, path }) => ({ _tag, path })),
        [
          { _tag: "OmittedValue", path: ["steps", 0] },
          { _tag: "OmittedValue", path: ["steps", 1] },
        ],
      )
      assert.deepEqual(
        G.diagnose(G.seq(opaque.pipe(G.skip<void>(undefined)), filtered.pipe(G.skip<void>(undefined)))),
        [],
      )
      assert.deepEqual(G.diagnose(G.tuple(opaque, filtered)), [])
      assert.deepEqual(G.diagnose(opaque.pipe(G.many())), [])
      assert.deepEqual(G.diagnose(filtered.pipe(G.many())), [])
      assert.deepEqual(calls, { encode: 0, decode: 0, predicate: 0 })
    }))

  it.effect("only omits optional and choice outputs when every branch is syntax-only", () =>
    Effect.sync(() => {
      const syntax = G.seq(
        G.optional(G.literal("a")),
        G.choice([G.literal("b"), word.pipe(G.skip("word"))]),
        G.choice([G.literal("c"), G.empty], { print: "roundTrip" }),
        G.suspend(() => G.seq(G.literal("d"), G.trivia)).pipe(G.between("[", "]"), G.label("syntax")),
      )
      assert.deepEqual(G.diagnose(syntax), [])

      const values = G.gen(function*() {
        yield* G.optional(word)
        yield* G.choice([G.empty, word])
        yield* G.choice([G.empty, word], { print: "roundTrip" })
      })
      assert.deepEqual(
        G.diagnose(values).map(({ _tag, path }) => ({ _tag, path })),
        [0, 1, 2].map((slot) => ({ _tag: "OmittedValue", path: ["steps", slot] })),
      )
    }))

  it.effect("checks all dependent match branches without selecting a runtime value", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const kind = yield* G.literals("a", "b")
        yield* G.match(kind, [
          ["a", G.literal("!")],
          ["b", G.optional(word.pipe(G.skip("word")))],
        ])
        yield* G.match(kind, [
          ["a", G.empty],
          ["b", word],
        ])
        return kind
      })
      assert.deepEqual(
        G.diagnose(grammar).map(({ _tag, path }) => ({ _tag, path })),
        [{ _tag: "OmittedValue", path: ["steps", 2] }],
      )
    }))

  it.effect("distinguishes empty-result gen syntax from discarded or constant values", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        yield* G.seq(G.literal("x"))
        yield* G.empty.pipe(G.as(undefined))
        yield* G.struct({})
        yield* G.tuple()
        yield* G.literal("y").pipe(G.as("y"))
        yield* G.gen(function*() {
          yield* word
        })
      })
      assert.deepEqual(
        G.diagnose(grammar).map(({ _tag, path }) => ({ _tag, path })),
        [
          { _tag: "OmittedValue", path: ["steps", 2] },
          { _tag: "OmittedValue", path: ["steps", 3] },
          { _tag: "OmittedValue", path: ["steps", 4] },
          { _tag: "OmittedValue", path: ["steps", 5] },
          { _tag: "OmittedValue", path: ["steps", 5, "steps", 0] },
        ],
      )
    }))

  it.effect("accepts whole syntax refs and explicitly supplied wrapper delimiters", () =>
    Effect.sync(() => {
      let calls = 0
      const delimiter = G.literal("!").pipe(
        G.transform<void, void>({
          decode: () => {
            calls++
          },
          encode: () => {
            calls++
          },
        }),
      )
      const syntax = G.gen(function*() {
        return yield* G.literal("x")
      }).pipe(G.between(delimiter, delimiter), G.prefix("["), G.suffix("]"))
      const grammar = G.seq(syntax)
      assert.deepEqual(G.diagnose(grammar), [])
      assert.equal(calls, 0)
      assert.equal(Result.getOrThrow(G.parse(grammar, "[!x!]")), undefined)
      assert.equal(Result.getOrThrow(G.print(grammar, undefined)), "[!x!]")
      // Wrapping an opaque output does not make that output safe to omit.
      assert.equal(G.diagnose(G.seq(delimiter.pipe(G.between("[", "]"))))[0]!._tag, "OmittedValue")
    }))

  it.effect("reports throwing suspensions under repetition and omitted steps without throwing", () =>
    Effect.sync(() => {
      let calls = 0
      const broken = G.suspend<void>(() => {
        calls++
        throw new Error("broken thunk")
      })
      assert.deepEqual(G.diagnose(broken.pipe(G.many())), [
        { _tag: "InvalidSuspend", path: ["inner"], message: "invalid suspend: broken thunk" },
      ])
      assert.equal(calls, 1)

      assert.deepEqual(
        G.diagnose(G.seq(broken)).map(({ _tag, path }) => ({ _tag, path })),
        [
          { _tag: "OmittedValue", path: ["steps", 0] },
          { _tag: "InvalidSuspend", path: ["steps", 0] },
        ],
      )
      assert.equal(calls, 2)
      // Queries can short-circuit, but graph inspection must still visit every branch.
      const issues = G.diagnose(G.choice([G.empty, broken]).pipe(G.many()))
      assert.deepEqual(
        issues.map(({ _tag, path }) => ({ _tag, path })),
        [
          { _tag: "EmptyRepetition", path: ["inner"] },
          { _tag: "InvalidSuspend", path: ["inner", "options", 1] },
        ],
      )
      assert.equal(calls, 3)
      assert.equal(G.diagnose(broken.pipe(G.optional, G.skip<void>(undefined)))[0]!._tag, "InvalidSuspend")
      assert.equal(G.diagnose(broken.pipe(G.repeat(0)))[0]!._tag, "InvalidSuspend")
    }))

  it.effect("terminates on valid recursive values and conservatively rejects omitted recursive output", () =>
    Effect.sync(() => {
      type Tree = number | ReadonlyArray<Tree>
      const tree: G.Grammar<Tree> = G.suspend(
        () => G.choice([G.integer, tree.pipe(G.sepBy(","), G.between("[", "]"))]),
        "tree",
      )
      assert.deepEqual(G.diagnose(tree), [])
      assert.deepEqual(G.diagnose(tree.pipe(G.many())), [])

      const recursiveSyntax: G.Grammar<void> = G.suspend(() =>
        G.choice([G.literal("x"), recursiveSyntax.pipe(G.between("[", "]"))])
      )
      assert.deepEqual(G.diagnose(recursiveSyntax), [])
      assert.deepEqual(
        G.diagnose(G.seq(recursiveSyntax)).map(({ _tag, path }) => ({ _tag, path })),
        [{ _tag: "OmittedValue", path: ["steps", 0] }],
      )
      assert.deepEqual(G.diagnose(G.seq(recursiveSyntax.pipe(G.skip<void>(undefined)))), [])
    }))

  it.effect("retains ancestor scope checks for shared recursive grammars in either branch order", () =>
    Effect.sync(() => {
      let shared: G.Grammar<string> | undefined
      const owner = G.gen(function*() {
        const size = yield* G.integer
        const payload = G.take(size)
        const recursive: G.Grammar<string> = G.suspend(() => G.choice([payload, recursive.pipe(G.between("[", "]"))]))
        shared = recursive
        const value = yield* recursive
        return { size, value }
      })
      assert.deepEqual(G.diagnose(owner), [])
      for (
        const options of [
          [owner, shared!],
          [shared!, owner],
        ] as const
      ) {
        const issues = G.diagnose(G.choice(options))
        assert.equal(issues.length, 1)
        assert.equal(issues[0]!._tag, "OutOfScopeRef")
        assert.deepEqual(issues[0]!.path, ["options", options[0] === owner ? 1 : 0, "resolved", "options", 0, "count"])
      }
    }))

  it.effect("includes case and wrapper edges in diagnostic paths", () =>
    Effect.sync(() => {
      const grammar = G.gen(function*() {
        const kind = yield* G.literal("a").pipe(G.as("a"))
        const value = yield* G.match(kind, [["a", escaped.pipe(G.between("[", "]"))]])
        return { kind, value }
      })
      const issues = G.diagnose(grammar)
      assert.equal(issues.length, 1)
      assert.deepEqual(issues[0]!.path, ["steps", 1, "cases", 0, "grammar", "steps", 1, "count"])
    }))
})

describe("direct operations", () => {
  it.effect("names construction and runtime errors without resolving unrelated suspensions", () =>
    Effect.sync(() => {
      let calls = 0
      const unrelated = G.suspend(() => {
        calls++
        return G.literal("y")
      }, "later")
      const product = G.tuple(word, unrelated)
      assert.equal(G.describe(product), "gen")
      assert.equal(G.describe(unrelated), "later")
      assert.throws(
        () =>
          G.gen(function*() {
            const value = yield* product
            return { first: value, second: value }
          }),
        /step 1 \(gen\) is returned twice/,
      )
      const omitted = G.gen(function*() {
        yield* product
      })
      assert.equal(Result.isFailure(G.printUnchecked(omitted, undefined)), true)

      const transform = G.choice([G.literal("x"), unrelated]).pipe(
        G.transform<void, void>({
          decode: () => {
            throw new Error("decode failed")
          },
          encode: () => {
            throw new Error("encode failed")
          },
        }),
      )
      const parsed = G.parse(transform, "x")
      const printed = G.printUnchecked(transform, undefined)
      assert.equal(Result.isFailure(parsed), true)
      assert.equal(Result.isFailure(printed), true)
      if (Result.isFailure(parsed)) assert.match(parsed.failure.message, /choice: decode failed/)
      if (Result.isFailure(printed)) assert.match(printed.failure.message, /choice.*encode failed/)
      assert.equal(calls, 0)
    }))

  it.effect("parse, print, and printUnchecked a sound grammar", () =>
    Effect.sync(() => {
      const g = G.struct({ host: word, port: G.integer.pipe(G.prefix(":")) })
      assert.deepEqual(G.diagnose(g), [])
      assert.deepEqual(Result.getOrThrow(G.parse(g, "h:80")), { host: "h", port: 80 })
      assert.equal(Result.getOrThrow(G.print(g, { host: "h", port: 80 })), "h:80")
      assert.equal(Result.getOrThrow(G.printUnchecked(g, { host: "h", port: 80 })), "h:80")
    }))

  it.effect("reports the issues of an invalid grammar", () =>
    Effect.sync(() => {
      const issues = G.diagnose(escaped)
      assert.equal(issues.length, 1)
      assert.match(issues[0]!.message, /take: uses a ref bound by a gen that is not an ancestor/)
    }))
})
