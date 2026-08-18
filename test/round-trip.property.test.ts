import assert from "node:assert/strict"

import { it } from "@effect/vitest"
import { Effect } from "effect"
import * as FastCheck from "effect/testing/FastCheck"
import { describe } from "vitest"

import * as Grammar from "../src/grammar.ts"

type Nested = number | ReadonlyArray<Nested>

const assertRoundTrips = <A>(
  label: string,
  grammar: Grammar.Grammar<A>,
  values: ReadonlyArray<A>,
): void => {
  for (const [index, value] of values.entries()) {
    const result = Effect.runSync(Effect.result(Grammar.checkRoundTrip(grammar, value)))
    if (result._tag === "Failure") {
      assert.fail(`${label}[${index}] failed: ${result.failure.message}`)
    }
  }
}

const integerValues = [
  ...Array.from({ length: 64 }, (_, seed) => ((seed * 37) % 2001) - 1000),
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
]

const listValues = Array.from({ length: 64 }, (_, seed) =>
  Array.from({ length: seed % 7 }, (_, index) => ((seed * 53 + index * 17) % 401) - 200),
)

const nested: Grammar.Grammar<Nested> = Grammar.lazy(() =>
  Grammar.choice(
    Grammar.guard(Grammar.integer, (value) => typeof value === "number"),
    Grammar.between(
      Grammar.symbol("["),
      Grammar.symbol("]"),
      Grammar.sepBy(nested, Grammar.symbol(",")),
    ),
  ),
)

const nestedValues: Array<Nested> = [
  0,
  1,
  -1,
  [],
  [1],
  [1, 2, 3],
  [1, [2, [3]]],
  [-1, [2, [-3]]],
  [[1], [], [2, [3, 4]]],
  ...Array.from({ length: 32 }, (_, seed): Nested => {
    const build = (depth: number, value: number): Nested =>
      depth === 0
        ? value % 100
        : [value % 100, ...(value % 2 === 0 ? [build(depth - 1, value + 1)] : [])]
    return build(seed % 5, seed + 5)
  }),
]

const nestedArbitrary = FastCheck.letrec<{ nested: Nested }>((tie) => ({
  nested: FastCheck.oneof(
    FastCheck.integer({ min: -100, max: 100 }),
    FastCheck.array(tie("nested"), { maxLength: 3 }),
  ),
})).nested

describe("round-trip properties", () => {
  it.effect("holds for deterministic integer boundaries", () =>
    Effect.sync(() => {
      assertRoundTrips("integer", Grammar.integer, integerValues)
    }),
  )

  it.effect("holds for deterministic separated lists", () =>
    Effect.sync(() => {
      assertRoundTrips(
        "integer list",
        Grammar.sepBy(Grammar.integer, Grammar.literal(",")),
        listValues,
      )
    }),
  )

  it.effect("holds for deterministic lazy nested values", () =>
    Effect.sync(() => {
      assertRoundTrips("nested", nested, nestedValues)
    }),
  )

  it.prop(
    "holds for arbitrary integer values",
    [FastCheck.integer({ min: -1_000_000, max: 1_000_000 })],
    ([value]) => assertRoundTrips("integer", Grammar.integer, [value]),
    { fastCheck: { numRuns: 64 } },
  )

  it.prop(
    "holds for arbitrary separated lists",
    [FastCheck.array(FastCheck.integer({ min: -200, max: 200 }), { maxLength: 6 })],
    ([value]) =>
      assertRoundTrips("integer list", Grammar.sepBy(Grammar.integer, Grammar.literal(",")), [
        value,
      ]),
    { fastCheck: { numRuns: 64 } },
  )

  it.prop(
    "holds for arbitrary lazy nested values",
    [nestedArbitrary],
    ([value]) => assertRoundTrips("nested", nested, [value]),
    { fastCheck: { numRuns: 64 } },
  )
})
