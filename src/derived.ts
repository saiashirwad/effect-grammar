import { Equal, Predicate, Schema } from "effect"

import {
  as,
  choice,
  empty,
  filter,
  gen,
  literal,
  regex,
  repeat,
  suffix,
  take,
  transform,
  type TransformOptions,
  trivia,
} from "./combinators.ts"
import type { Grammar, Ref } from "./core.ts"

export const literals = <const Values extends readonly [string, ...Array<string>]>(
  ...values: Values
): Grammar<Values[number]> => {
  const longestFirst = values.toSorted((left, right) => right.length - left.length)
  // SAFETY: `values` is non-empty, so the sorted branches are too.
  return choice(...(longestFirst.map((value) => as(value)(literal(value))) as [Grammar<Values[number]>]))
}

export const flag = (value: Grammar<void> | string): Grammar<boolean> =>
  choice(as(true)(Predicate.isString(value) ? literal(value) : value), as(false)(empty))

export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>, name = "a value matching the schema") =>
  <A>(options: TransformOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> =>
    inner.pipe(transform(options), filter(Schema.is(schema), name))

export const defaulted =
  <A>(value: A) =>
  (inner: Grammar<A | undefined>): Grammar<A> =>
    inner.pipe(
      transform({
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
    transform({
      decode: ({ body }) => body,
      encode: (body: string) => ({ size: body.length, body }),
    }),
  )

export const lengthPrefixed = (length: Grammar<number>): Grammar<string> => prefixedBy(length, take)

export const countPrefixed =
  (count: Grammar<number>) =>
  <A>(item: Grammar<A>): Grammar<ReadonlyArray<A>> =>
    gen(function* () {
      const size = yield* count
      const items = yield* repeat(size)(item)
      return { size, items }
    }).pipe(
      transform({
        decode: ({ items }) => items,
        encode: (items: ReadonlyArray<A>) => ({ size: items.length, items }),
      }),
    )

export const lexeme = suffix(trivia)

export const symbol = (value: string): Grammar<void> => lexeme(literal(value))

export const integer = regex(/-?\d+/, "integer").pipe(
  transform({
    decode: (text) => {
      const value = Number(text)
      return Object.is(value, -0) ? 0 : value
    },
    encode: String,
  }),
  filter(Number.isSafeInteger, "integer"),
)
