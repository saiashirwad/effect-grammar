import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"

import * as Grammar from "../src/index.ts"
import { assertRoundTrip } from "./helpers.ts"

type Nested = number | ReadonlyArray<Nested>

const nested: Grammar.Grammar<Nested> = Grammar.suspend(() =>
  Grammar.choice(
    Grammar.integer,
    Grammar.wrap(
      Grammar.symbol("["),
      Grammar.sepBy(nested, Grammar.symbol(",")),
      Grammar.symbol("]"),
    ).pipe(
      Grammar.transform({
        decode: (a): Nested => a,
        // SAFETY: `sepBy` yields an array and `encode` only runs on values that passed `is: Array.isArray`.
        encode: (a) => a as Array<Nested>,
        is: Array.isArray,
      }),
    ),
  ),
)

const nestedArb: FastCheck.Arbitrary<Nested> = FastCheck.letrec<{ nested: Nested }>((tie) => ({
  nested: FastCheck.oneof(
    { depthSize: "small" },
    FastCheck.integer({ min: -1000, max: 1000 }),
    FastCheck.array(tie("nested"), { maxLength: 4 }),
  ),
})).nested

const endpoint = Grammar.gen(function* () {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.field("host", Grammar.regex(/[a-z][a-z0-9.-]*/, "host"))
  const port = yield* Grammar.field("port", Grammar.optional(Grammar.prefix(":", Grammar.integer)))
  const path = yield* Grammar.field(
    "path",
    Grammar.many(Grammar.prefix("/", Grammar.regex(/[a-z0-9]+/, "segment"))),
  )
  return { host, port, path }
})

const endpointArb = FastCheck.record({
  host: FastCheck.stringMatching(/^[a-z][a-z0-9.-]{0,12}$/),
  port: FastCheck.option(FastCheck.integer({ min: 0, max: 65535 }), { nil: undefined }),
  path: FastCheck.array(FastCheck.stringMatching(/^[a-z0-9]{1,6}$/), { maxLength: 4 }),
})

describe("round-trip law: parse(print(a)) == a", () => {
  it("integer", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        (n) => {
          assertRoundTrip(Grammar.integer, n)
        },
      ),
    )
  })

  it("nested integer lists with lexemes", () => {
    FastCheck.assert(
      FastCheck.property(nestedArb, (value) => {
        assertRoundTrip(nested, value)
      }),
    )
  })

  it("gen grammar with optional and repeated fields", () => {
    FastCheck.assert(
      FastCheck.property(endpointArb, (value) => {
        assertRoundTrip(endpoint, value)
      }),
    )
  })
})
