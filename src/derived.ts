import { Equal, Function as F, Predicate, Schema } from "effect"

import {
  as,
  choice,
  empty,
  gen,
  iso,
  literal,
  regex,
  repeat,
  suffix,
  take,
  type TransformOptions,
  trivia,
} from "./combinators.ts"
import type { Grammar, Ref, Silent } from "./core.ts"

// Return the matched string, trying longest first to avoid prefix shadowing.
// Equal-length strings keep their listed order.
export const literals = <const Values extends readonly [string, ...Array<string>]>(
  ...values: Values
): Grammar<Values[number]> => {
  const longestFirst = values.toSorted((left, right) => right.length - left.length)
  // SAFETY: `values` is non-empty, so the sorted branches are too.
  return choice(...(longestFirst.map((value) => as(literal(value), value)) as [Grammar<Values[number]>]))
}

export const flag = (value: Silent | string): Grammar<boolean> =>
  choice(as(Predicate.isString(value) ? literal(value) : value, true), as(empty, false))

// An `iso` whose `is` defaults to the schema's guard.
export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(options: TransformOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> =>
    iso(inner, { ...options, is: options.is ?? Schema.is(schema) })

// Replace `undefined` with the default when parsing; omit equal values when
// printing. Other parsed values, including `null`, are unchanged.
export const defaulted: {
  <A>(value: A): (inner: Grammar<A | undefined>) => Grammar<A>
  <A>(inner: Grammar<A | undefined>, value: A): Grammar<A>
} = F.dual(2, <A>(inner: Grammar<A | undefined>, value: A) =>
  iso(inner, {
    decode: (input) => (input === undefined ? value : input),
    encode: (input) => (Equal.equals(input, value) ? undefined : input),
  }),
)

export const prefixedBy = (length: Grammar<number>, take: (length: Ref<number>) => Grammar<string>): Grammar<string> =>
  gen(function* () {
    const size = yield* length
    const body = yield* take(size)
    return { size, body }
  }).pipe(
    iso({
      decode: ({ body }) => body,
      encode: (body: string) => ({ size: body.length, body }),
    }),
  )

export const lengthPrefixed = (length: Grammar<number>): Grammar<string> => prefixedBy(length, take)

export const countPrefixed: {
  <A>(item: Grammar<A>, count: Grammar<number>): Grammar<ReadonlyArray<A>>
  (count: Grammar<number>): <A>(item: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(2, <A>(item: Grammar<A>, count: Grammar<number>) =>
  gen(function* () {
    const size = yield* count
    const items = yield* repeat(item, size)
    return { size, items }
  }).pipe(
    iso({
      decode: ({ items }) => items,
      encode: (items: ReadonlyArray<A>) => ({ size: items.length, items }),
    }),
  ),
)

export const lexeme = suffix(trivia)

export const symbol = (value: string): Silent => lexeme(literal(value))

export const integer = regex(/-?\d+/, "integer").pipe(
  iso({
    decode: (text) => {
      const value = Number(text)
      return Object.is(value, -0) ? 0 : value
    },
    encode: String,
    is: Number.isSafeInteger,
    name: "integer",
  }),
)
