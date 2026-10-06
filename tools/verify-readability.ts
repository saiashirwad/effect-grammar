import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"

import { Console, Effect, Predicate, Result, Schema } from "effect"

import type { Grammar, Value } from "../src/core.ts"
import type { ParseError, PrintError } from "../src/errors.ts"

interface Modules {
  readonly grammar: typeof import("../src/index.ts")
  readonly binary: typeof import("../src/binary.ts")
  readonly adapter: typeof import("../src/schema.ts")
  readonly json: typeof import("../examples/grammars/json.ts").jsonValue
}

interface Runners<Input, D extends "text" | "bytes"> {
  readonly parse: <A>(grammar: Grammar<A, D>, input: Input) => Result.Result<A, ParseError>
  readonly print: <A>(grammar: Grammar<A, D>, value: A) => Result.Result<Input, PrintError>
  readonly printUnchecked: <A>(grammar: Grammar<A, D>, value: A) => Result.Result<Input, PrintError>
}

const baseline = process.argv[2]
assert.ok(baseline, "usage: node tools/verify-readability.ts <baseline-worktree>")

const load = (root: string): Effect.Effect<Modules, Error> => {
  const base = pathToFileURL(`${root}/`)
  const module = <T>(path: string) => Effect.tryPromise<T>(() => import(new URL(path, base).href))
  return Effect.all({
    grammar: module<Modules["grammar"]>("src/index.ts"),
    binary: module<Modules["binary"]>("src/binary.ts"),
    adapter: module<Modules["adapter"]>("src/schema.ts"),
    json: module<typeof import("../examples/grammars/json.ts")>("examples/grammars/json.ts"),
  }).pipe(Effect.map(({ json, ...modules }) => ({ ...modules, json: json.jsonValue })))
}

const serialize = <A>(value: A): string =>
  JSON.stringify(value, (_, item) => {
    if (item === undefined) return { undefined: true }
    if (Predicate.isBigInt(item)) return { bigint: String(item) }
    if (Predicate.isUint8Array(item)) return { bytes: Array.from(item) }
    if (Predicate.isNumber(item) && !Number.isFinite(item)) return { number: String(item) }
    if (Object.is(item, -0)) return { number: "-0" }
    if (Predicate.isObject(item)) {
      const fields = Object.entries(Object.getOwnPropertyDescriptors(item))
      if (fields.some(([, field]) => field.get !== undefined || field.set !== undefined)) {
        return {
          descriptors: Object.fromEntries(
            fields.map((
              [key, field],
            ) => [
              key,
              "value" in field
                ? { value: field.value }
                : { get: field.get !== undefined, set: field.set !== undefined },
            ]),
          ),
        }
      }
    }
    return item
  })

const optionalErrorChanges = new Set([
  "optional:print:\"\"",
  "optional:unchecked:\"\"",
  "optional errors:print:\"b\"",
  "optional errors:unchecked:\"b\"",
])

const exercise = ({ grammar: G, binary: B, adapter, json }: Modules, before: boolean) => {
  const records: Array<readonly [string, Value]> = []
  const record = <A>(name: string, result: Result.Result<A, ParseError | PrintError>) => {
    if (Result.isSuccess(result)) {
      records.push([name, ["success", serialize(result.success)]])
      return
    }
    const error = result.failure
    if (error._tag === "PrintError") {
      let issue = error.issue
      if (before && optionalErrorChanges.has(name)) {
        assert.equal(issue._tag, "NoAlternative", name)
        if (issue._tag === "NoAlternative") issue = issue.issues[0]!
      }
      records.push([name, ["failure", serialize({ issue, message: G.PrintError.format(issue) })]])
    } else {
      records.push([name, [
        "failure",
        serialize({
          pos: error.pos,
          line: error.line,
          column: error.column,
          expected: error.expected,
          found: error.found,
          message: error.message,
        }),
      ]])
    }
  }
  const check = <A, Input, D extends "text" | "bytes">(
    name: string,
    grammar: Grammar<A, D>,
    inputs: ReadonlyArray<Input>,
    values: ReadonlyArray<NoInfer<A>>,
    runners: Runners<Input, D>,
  ) => {
    for (const input of inputs) record(`${name}:parse:${serialize(input)}`, runners.parse(grammar, input))
    for (const value of values) {
      record(`${name}:print:${serialize(value)}`, runners.print(grammar, value))
      record(`${name}:unchecked:${serialize(value)}`, runners.printUnchecked(grammar, value))
    }
  }
  const text = <A>(
    name: string,
    grammar: Grammar<A>,
    inputs: ReadonlyArray<string>,
    values: ReadonlyArray<NoInfer<A>>,
  ) => check(name, grammar, inputs, values, G)
  const bytes = <A>(
    name: string,
    grammar: Grammar<A, "bytes">,
    inputs: ReadonlyArray<Uint8Array>,
    values: ReadonlyArray<NoInfer<A>>,
  ) => check(name, grammar, inputs, values, B)

  let builds = 0
  const packet = G.gen(function*() {
    builds++
    const size = yield* G.integer.pipe(G.suffix(":"))
    const body = yield* G.gen(function*() {
      const count = yield* G.integer.pipe(G.suffix(":"))
      const value = yield* G.take(size).pipe(
        G.between(G.take(count).pipe(G.skip("!")), G.take(size).pipe(G.skip("??"))),
      )
      return { value, count }
    }).pipe(G.between("<", ">"), G.prefix("#"), G.suffix(";"))
    return { body, size, empty: [], constant: null }
  })
  const valid = { body: { value: "xy", count: 1 }, size: 2, empty: [], constant: null }
  const extra = { ...valid, extra: true }
  text("nested dependencies", packet, ["2:#<1:!xy??>;", "2:#<2:!xy??>;", ""], [
    valid,
    { ...valid, body: { value: "x", count: 1 } },
    extra,
  ])
  records.push(["generator builds", builds])

  const word = G.regex(/[a-z]+/)
  text("optional", G.optional(word), ["", "abc", "1"], [undefined, "abc", ""])
  text("optional errors", G.optional(G.regex(/a/)), ["a", "b"], ["a", "b"])
  text("optional syntax", G.optional(G.literal("a")), ["", "a", "aa"], [undefined])
  text("overlap", G.choice([G.integer, G.regex(/[a-z0-9]+/), word.pipe(G.between("\"", "\""))]), [
    "123",
    "abc",
    "\"abc\"",
  ], [123, "123", "abc"])
  const dispatch = G.dispatch("kind", [
    ["n", G.struct({ kind: G.literal("n").pipe(G.as("n" as const)), value: G.integer })],
    ["s", G.struct({ kind: G.literal("s").pipe(G.as("s" as const)), value: word })],
  ])
  text("dispatch", dispatch, ["n3", "sab", "x"], [
    { kind: "n", value: 3 },
    { kind: "s", value: "ab" },
  ])
  text("zero width", G.empty.pipe(G.many()), [""], [[], [undefined]])
  text("json", json, ["{\"a\":[1,true,null,\"x\"]}", "[[]]", "{bad}"], [
    { a: [1, true, null, "x"] },
    [[], {}],
  ])

  const textCodec = adapter.codec(G.integer, Schema.Int)
  records.push(["schema decode", Schema.decodeSync(textCodec)("007")])
  records.push(["schema encode", Schema.encodeSync(textCodec)(7)])
  const message = B.lengthPrefixed(B.uint8).pipe(B.utf8, G.countPrefixed(B.uint8))
  bytes("utf8 counts", message, [Uint8Array.of(2, 3, 0xe2, 0x82, 0xac, 2, 0x79, 0x6f)], [
    ["€", "yo"],
    [],
    ["\ud800"],
  ])
  const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  bytes("all bytes", B.bytes(256), [allBytes, allBytes.slice(1)], [allBytes])
  for (const name of ["float32", "float64", "float32le", "float64le"] as const) {
    bytes(name, B[name], [], [0, -0, 1.5, NaN, Infinity, -Infinity])
  }
  bytes("varuint", B.varuint, [Uint8Array.of(0), Uint8Array.of(0xff, 1), Uint8Array.of(0x80)], [
    0,
    127,
    128,
    Number.MAX_SAFE_INTEGER,
  ])

  const reads: Array<string> = []
  const returnOrder = G.gen(function*() {
    const first = yield* G.integer.pipe(G.suffix(":"))
    const second = yield* G.integer
    return { second, first }
  })
  record(
    "getter order",
    G.printUnchecked(returnOrder, {
      get second() {
        reads.push("second")
        return 2
      },
      get first() {
        reads.push("first")
        return 1
      },
    }),
  )
  records.push(["reads", reads])
  const stopped: Array<string> = []
  record(
    "getter failure",
    G.printUnchecked(returnOrder, {
      get second(): number {
        stopped.push("second")
        throw new Error("stop")
      },
      get first() {
        stopped.push("first")
        return 1
      },
    }),
  )
  records.push(["stopped reads", stopped])
  return records
}

const expected = exercise(await Effect.runPromise(load(baseline)), true)
const actual = exercise(await Effect.runPromise(load(fileURLToPath(new URL("..", import.meta.url)))), false)
assert.deepEqual(actual, expected)
Effect.runSync(
  Console.log(
    `Verified ${actual.length} baseline comparisons, including values, output, structured failures and getter order; four intentional optional-error changes normalized.`,
  ),
)
