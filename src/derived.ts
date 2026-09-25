import { Equal, Predicate, Result } from "effect"

import {
  as,
  choice,
  dispatch,
  empty,
  filter,
  gen,
  literal,
  regex,
  repeat,
  suffix,
  take,
  toGrammar,
  transform,
  transformOrFail,
  trivia,
} from "./combinators.ts"
import type { AnyGrammar, Domain, DomainOf, Grammar, MatchKey, Type, Value } from "./core.ts"
import { preview } from "./errors.ts"
import { prefixedBy } from "./internal/prefixed.ts"

type Entries = ReadonlyArray<readonly [MatchKey, AnyGrammar]>

type TaggedValue<Tag extends string, E extends Entries> = {
  readonly [I in keyof E]: E[I] extends readonly [infer K extends MatchKey, infer G]
    ? Readonly<Record<Tag, K>> & { readonly value: Type<G> }
    : never
}[number]

export function taggedChoice<const Tag extends string, const E extends Entries>(
  tag: Tag extends "value" ? never : Tag,
  entries: E,
): Grammar<TaggedValue<Tag, E>, DomainOf<E[number][1]>>
export function taggedChoice<Tag extends string>(tag: Tag, entries: Entries): AnyGrammar {
  if (tag === "value") throw new RangeError("taggedChoice: tag name \"value\" is reserved")
  type Branch = Readonly<Record<Tag, MatchKey>> & { readonly value: Value }
  const branches = entries.map(([key, grammar]) => {
    // SAFETY: entries pair keys with grammars; only the payload type is erased.
    const branch = (grammar as Grammar<Value, Domain>).pipe(
      transformOrFail<Value, Branch>({
        // SAFETY: the computed field has exactly the supplied tag and key.
        decode: (value) => Result.succeed({ [tag]: key, value } as Branch),
        encode: (value) => {
          if (!Predicate.isObject(value) || !Object.hasOwn(value, tag) || value[tag] !== key) {
            return Result.fail(`expected an object with ${tag} equal to ${preview(key)}`)
          }
          if (!Object.hasOwn(value, "value")) return Result.fail("expected an object with a value field")
          return Result.succeed(value.value)
        },
      }),
    )
    return [key, branch] as const
  })
  return dispatch(tag, branches)
}

export const literals = <const Values extends readonly [string, ...Array<string>]>(
  ...values: Values
): Grammar<Values[number]> => {
  const longestFirst = values.toSorted((left, right) => right.length - left.length)
  // SAFETY: `values` is non-empty, so the sorted branches are too.
  // Each branch prints only its own constant, so a round-trip print check would be pure cost.
  return choice(longestFirst.map((value) => as(value)(literal(value))) as [Grammar<Values[number]>], {
    print: "first",
  })
}

// The branches print only true and only false respectively, so a round-trip print check would be pure cost.
export const flag = <T extends Grammar<void, Domain> | string>(value: T) =>
  choice([as(true)(toGrammar(value)), as(false)(empty)], { print: "first" })

export const defaulted = <A>(value: A) => <D extends Domain>(inner: Grammar<A | undefined, D>): Grammar<A, D> =>
  inner.pipe(
    transform({
      decode: (input) => (input === undefined ? value : input),
      encode: (input) => (Equal.equals(input, value) ? undefined : input),
    }),
  )

export const lengthPrefixed = (length: Grammar<number>): Grammar<string> => prefixedBy(length, take)

export const countPrefixed =
  <C extends Domain>(count: Grammar<number, C>) =>
  <A, D extends Domain>(item: Grammar<A, D>): Grammar<ReadonlyArray<A>, C | D> =>
    gen(function*() {
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
