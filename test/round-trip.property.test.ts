import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Effect } from "effect"

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
    Grammar.guard(
      Grammar.map(Grammar.regex(/\d+/, "digits"), { to: Number, from: String }),
      (value) => typeof value === "number",
    ),
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
  [],
  [1],
  [1, 2, 3],
  [1, [2, [3]]],
  [[1], [], [2, [3, 4]]],
  ...Array.from({ length: 32 }, (_, seed): Nested => {
    const build = (depth: number, value: number): Nested =>
      depth === 0
        ? value % 100
        : [value % 100, ...(value % 2 === 0 ? [build(depth - 1, value + 1)] : [])]
    return build(seed % 5, seed + 5)
  }),
]

describe("round-trip properties", () => {
  it("holds for generated integer values", () => {
    assertRoundTrips("integer", Grammar.integer, integerValues)
  })

  it("holds for generated separated lists", () => {
    assertRoundTrips(
      "integer list",
      Grammar.sepBy(Grammar.integer, Grammar.literal(",")),
      listValues,
    )
  })

  it("holds for generated lazy nested values", () => {
    assertRoundTrips("nested", nested, nestedValues)
  })
})
