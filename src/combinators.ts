import { Predicate, Result, Schema } from "effect"

import {
  type AnyGrammar,
  type Domain,
  type DomainOf,
  type Expr,
  type Grammar,
  isCount,
  make,
  type MatchKey,
  nodeOf,
  type OutputSchema,
  type Ref,
  type ScopeId,
  type Type,
} from "./core.ts"
import { preview } from "./errors.ts"
import { assertInScope, sequence } from "./internal/generator.ts"

export { gen, get } from "./internal/generator.ts"

export const literal = (value: string): Grammar<void> => make({ _tag: "Literal", value })

export const empty = make<void, never>({ _tag: "Literal", value: "" })

type Delimiter = Grammar<void, Domain> | string
type DelimiterDomain<T> = T extends string ? "text" : DomainOf<T>

export const toGrammar = <T extends Delimiter>(value: T): Grammar<void, DelimiterDomain<T>> =>
  make(Predicate.isString(value) ? { _tag: "Literal", value } : nodeOf(value))

export const label = (name: string) => <A, D extends Domain>(inner: Grammar<A, D>): Grammar<A, D> =>
  make({ _tag: "Label", inner, name })

export const regex = (expression: RegExp, name?: string): Grammar<string> => {
  const grammar = make<string>({
    _tag: "Regex",
    source: expression.source,
    flags: expression.flags.replace(/[gy]/g, ""),
  })
  return name === undefined ? grammar : label(name)(grammar)
}

export const countExpr = (count: Ref<number> | number, where: string): Expr => {
  if (!Predicate.isNumber(count)) return assertInScope(count, where)
  if (!isCount(count)) throw new RangeError(`${where}: count must be a non-negative safe integer`)
  return { _tag: "Const", value: count }
}

export const take = (count: Ref<number> | number): Grammar<string> =>
  make({ _tag: "Take", count: countExpr(count, "take") })

export const seq = <const Parts extends ReadonlyArray<Grammar<void, Domain>>>(
  ...parts: Parts
): Grammar<void, DomainOf<Parts[number]>> => sequence({ _tag: "ScopeId" }, parts, { _tag: "Const", value: undefined })

type StructValue<Fields extends Readonly<Record<string, AnyGrammar>>> = {
  readonly [K in keyof Fields]: Type<Fields[K]>
}

export const struct = <const Fields extends Readonly<Record<string, AnyGrammar>>>(
  fields: Fields,
): Grammar<StructValue<Fields>, DomainOf<Fields[keyof Fields]>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  const entries = Object.entries(fields)
  return sequence(
    scope,
    entries.map(([, grammar]) => grammar),
    { _tag: "Object", fields: entries.map(([key], slot) => [key, { _tag: "Slot", slot }]) },
  )
}

type TupleValue<Elements extends ReadonlyArray<AnyGrammar>> = {
  readonly [K in keyof Elements]: Type<Elements[K]>
}

export const tuple = <const Elements extends ReadonlyArray<AnyGrammar>>(
  ...elements: Elements
): Grammar<TupleValue<Elements>, DomainOf<Elements[number]>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  return sequence(scope, elements, { _tag: "Array", items: elements.map((_, slot) => ({ _tag: "Slot", slot })) })
}

export const as = <const V>(value: V) => <D extends Domain>(inner: Grammar<void, D>): Grammar<V, D> =>
  sequence({ _tag: "ScopeId" }, [inner], { _tag: "Const", value })

export const between =
  <Open extends Delimiter, Close extends Delimiter>(open: Open, close: Close) =>
  <A, D extends Domain>(inner: Grammar<A, D>): Grammar<A, D | DelimiterDomain<Open> | DelimiterDomain<Close>> =>
    make({ _tag: "Surrounded", open: toGrammar(open), inner, close: toGrammar(close) })

export const prefix = <Open extends Delimiter>(open: Open) => between(open, empty)

export const suffix = <Close extends Delimiter>(close: Close) => between(empty, close)

const assertUniqueKeys = (keys: ReadonlyArray<MatchKey>, where: string): void => {
  const seen = new Set<MatchKey>()
  for (const key of keys) {
    if (seen.has(key)) throw new RangeError(`${where}: duplicate key ${preview(key)}`)
    seen.add(key)
  }
}

type Options = readonly [AnyGrammar, ...Array<AnyGrammar>]

export interface ChoiceOptions {
  /**
   * `"roundTrip"` (default) keeps a branch's output only if it reparses through the choice to an
   * equal value. `"first"` keeps the first branch that prints; use it when branches cannot overlap.
   */
  readonly print?: "first" | "roundTrip"
}

export const choice = <const Grammars extends Options>(
  options: Grammars,
  policy?: ChoiceOptions,
): Grammar<Type<Grammars[number]>, DomainOf<Grammars[number]>> =>
  make({ _tag: "Choice", options, print: policy?.print ?? "roundTrip" })

type Entries = ReadonlyArray<readonly [MatchKey, AnyGrammar]>

type EntryOutput<E extends Entries> = Type<E[number][1]>

const cases = (
  entries: Entries,
  where: string,
): ReadonlyArray<{ readonly key: MatchKey; readonly grammar: AnyGrammar }> => {
  if (entries.length === 0) throw new RangeError(`${where}: at least one case is required`)
  assertUniqueKeys(
    entries.map(([key]) => key),
    where,
  )
  return entries.map(([key, grammar]) => ({ key, grammar }))
}

type TaggedEntries<Tag extends string, E extends Entries> = {
  readonly [I in keyof E]: E[I] extends readonly [infer K extends MatchKey, unknown]
    ? Type<E[I][1]> extends Readonly<Record<Tag, K>> ? E[I]
    : readonly [K, Grammar<Readonly<Record<Tag, K>>, Domain>]
    : never
}

export const dispatch = <const Tag extends string, const E extends Entries>(
  tag: Tag,
  entries: E & TaggedEntries<Tag, E>,
): Grammar<EntryOutput<E>, DomainOf<E[number][1]>> => {
  return make({ _tag: "Dispatch", tag, cases: cases(entries, "dispatch") })
}

type CompleteEntries<K extends MatchKey, E extends Entries> = Exclude<K, E[number][0]> extends never ? E : never

export const match = <K extends MatchKey, const E extends ReadonlyArray<readonly [K, AnyGrammar]>>(
  scrutinee: Ref<K>,
  entries: CompleteEntries<K, E>,
): Grammar<EntryOutput<E>, DomainOf<E[number][1]>> =>
  make({ _tag: "Match", scrutinee: assertInScope(scrutinee, "match"), cases: cases(entries, "match") })

export const optional = <A, D extends Domain>(inner: Grammar<A, D>): Grammar<A | undefined, D> =>
  make({ _tag: "Optional", inner })

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const repeatNode =
  <S extends Domain>(where: string, sep: Grammar<void, S>, options: RepeatOptions | undefined) =>
  <A, D extends Domain>(inner: Grammar<A, D>): Grammar<ReadonlyArray<A>, D | S> => {
    const min = options?.min ?? 0
    const max = options?.max
    if (!isCount(min)) throw new RangeError(`${where}: min must be a non-negative safe integer`)
    if (max !== undefined && (!isCount(max) || max < min)) {
      throw new RangeError(`${where}: max must be a safe integer >= min`)
    }
    return make({
      _tag: "Repeat",
      inner,
      sep,
      min: { _tag: "Const", value: min },
      max: max === undefined ? undefined : { _tag: "Const", value: max },
    })
  }

export const many = (options?: RepeatOptions) => repeatNode("many", empty, options)

export const sepBy = <S extends Delimiter>(separator: S, options?: RepeatOptions) =>
  repeatNode("sepBy", toGrammar(separator), options)

export const repeat =
  (count: Ref<number> | number) => <A, D extends Domain>(inner: Grammar<A, D>): Grammar<ReadonlyArray<A>, D> => {
    const expr = countExpr(count, "repeat")
    return make({ _tag: "Repeat", inner, sep: empty, min: expr, max: expr })
  }

export interface TransformOptions<A, B> {
  /**
   * The schema of every decoded value. `codec(grammar)` uses its type side to describe this
   * transform's output; parsing and printing do not consult it.
   */
  readonly to?: Schema.Schema<B> | undefined
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
}

export interface TransformOrFailOptions<A, B> {
  /**
   * The schema of every decoded value. `codec(grammar)` uses its type side to describe this
   * transform's output; parsing and printing do not consult it.
   */
  readonly to?: Schema.Schema<B> | undefined
  readonly decode: (a: A) => Result.Result<B, string>
  readonly encode: (b: B) => Result.Result<A, string>
}

export const transformNode = <A, B, D extends Domain>(
  inner: Grammar<A, D>,
  decode: (a: A) => Result.Result<B, string>,
  encode: (b: B) => Result.Result<A, string>,
  schema: OutputSchema | undefined,
): Grammar<B, D> => make({ _tag: "Transform", inner, decode, encode, schema })

const declared = <B>(to: Schema.Schema<B> | undefined): OutputSchema | undefined =>
  to === undefined ? undefined : () => ({ _tag: "Schema", schema: Schema.toType(to) })

export const transform =
  <A, B>(options: TransformOptions<A, B>) => <D extends Domain>(inner: Grammar<A, D>): Grammar<B, D> =>
    transformNode(
      inner,
      (value) => Result.succeed(options.decode(value)),
      (value) => Result.succeed(options.encode(value)),
      declared(options.to),
    )

export const transformOrFail =
  <A, B>(options: TransformOrFailOptions<A, B>) => <D extends Domain>(inner: Grammar<A, D>): Grammar<B, D> =>
    transformNode(inner, options.decode, options.encode, declared(options.to))

export function filter<A, B extends A>(
  refinement: (value: A) => value is B,
  name: string,
): <I extends A, D extends Domain>(inner: Grammar<I, D>) => Grammar<I & B, D>
export function filter<A>(
  predicate: (value: A) => boolean,
  name: string,
): <I extends A, D extends Domain>(inner: Grammar<I, D>) => Grammar<I, D>
export function filter<A>(predicate: (value: A) => boolean, name: string) {
  return <I extends A, D extends Domain>(inner: Grammar<I, D>): Grammar<I, D> =>
    make({ _tag: "Filter", inner, predicate, name })
}

export const skip = <A>(printAs: A) => <D extends Domain>(inner: Grammar<A, D>): Grammar<void, D> =>
  make({ _tag: "Skip", inner, printAs, hidden: false })

export const suspend = <A, D extends Domain = "text">(thunk: () => Grammar<A, D>, name?: string): Grammar<A, D> =>
  make({ _tag: "Suspend", thunk, name })

const hiddenWhitespace = (expression: RegExp, name: string, printAs: string): Grammar<void> =>
  make({ _tag: "Skip", inner: regex(expression, name), printAs, hidden: true })

export const trivia = hiddenWhitespace(/\s*/, "trivia", "")
export const space = literal(" ")
export const spaces = hiddenWhitespace(/\s+/, "whitespace", " ")
