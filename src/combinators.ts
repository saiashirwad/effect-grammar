import { Predicate, Result } from "effect"

import {
  type AnyGrammar,
  type Denote,
  type Domain,
  type DomainOf,
  type Expr,
  type Grammar,
  isCount,
  isGrammar,
  make,
  type MatchKey,
  nodeOf,
  type Ref,
  type ScopeId,
  type Type,
} from "./core.ts"
import { preview } from "./errors.ts"
import { describeStep } from "./internal/describe.ts"
import { presentOnly } from "./internal/syntax.ts"
import { type Pattern, returnPattern, toPattern } from "./pattern.ts"
import { assertInScope, refFor, type Scope } from "./ref.ts"

export { get } from "./ref.ts"

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

const makeGen = <A, D extends Domain>(scope: ScopeId, steps: ReadonlyArray<AnyGrammar>, tree: Pattern): Grammar<A, D> =>
  make({
    _tag: "Gen",
    scope,
    steps,
    result: returnPattern(tree, scope, (slot) => describeStep(steps[slot]!, slot)),
  })

export const gen = <Y extends AnyGrammar, R>(run: () => Generator<Y, R, unknown>): Grammar<Denote<R>, DomainOf<Y>> => {
  const iterator = run()
  const steps: Array<AnyGrammar> = []
  const scope: Scope = { id: { _tag: "ScopeId" }, open: true }

  try {
    let result = iterator.next()
    while (!result.done) {
      const grammar = result.value
      if (!isGrammar(grammar)) throw new TypeError("gen: only a grammar can be yielded")
      const slot = steps.push(grammar) - 1
      result = iterator.next(refFor({ _tag: "Ref", scope: scope.id, slot }, scope))
    }
    return makeGen(scope.id, steps, toPattern(result.value))
  } finally {
    scope.open = false
  }
}

export const seq = <const Parts extends ReadonlyArray<Grammar<void, Domain>>>(
  ...parts: Parts
): Grammar<void, DomainOf<Parts[number]>> => makeGen({ _tag: "ScopeId" }, parts, { _tag: "Const", value: undefined })

type StructValue<Fields extends Readonly<Record<string, AnyGrammar>>> = {
  readonly [K in keyof Fields]: Type<Fields[K]>
}

export const struct = <const Fields extends Readonly<Record<string, AnyGrammar>>>(
  fields: Fields,
): Grammar<StructValue<Fields>, DomainOf<Fields[keyof Fields]>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  const entries = Object.entries(fields)
  return makeGen(
    scope,
    entries.map(([, grammar]) => grammar),
    { _tag: "Object", fields: entries.map(([key], slot) => [key, { _tag: "Ref", scope, slot }]) },
  )
}

type TupleValue<Elements extends ReadonlyArray<AnyGrammar>> = {
  readonly [K in keyof Elements]: Type<Elements[K]>
}

export const tuple = <const Elements extends ReadonlyArray<AnyGrammar>>(
  ...elements: Elements
): Grammar<TupleValue<Elements>, DomainOf<Elements[number]>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  return makeGen(scope, elements, { _tag: "Array", items: elements.map((_, slot) => ({ _tag: "Ref", scope, slot })) })
}

export const as = <const V>(value: V) => <D extends Domain>(inner: Grammar<void, D>): Grammar<V, D> =>
  makeGen({ _tag: "ScopeId" }, [inner], { _tag: "Const", value })

export const between =
  <Open extends Delimiter, Close extends Delimiter>(open: Open, close: Close) =>
  <A, D extends Domain>(inner: Grammar<A, D>): Grammar<A, D | DelimiterDomain<Open> | DelimiterDomain<Close>> => {
    const scope: ScopeId = { _tag: "ScopeId" }
    return makeGen(scope, [skip<void>(undefined)(toGrammar(open)), inner, skip<void>(undefined)(toGrammar(close))], {
      _tag: "Ref",
      scope,
      slot: 1,
    })
  }

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
  const checked = cases(entries, "dispatch")
  // The tag already selects the printed branch, so the round-trip search never applies.
  return make({
    _tag: "Choice",
    options: checked.map((matchCase) => matchCase.grammar),
    print: "first",
    by: { tag, keys: checked.map((matchCase) => matchCase.key) },
  })
}

type CompleteEntries<K extends MatchKey, E extends Entries> = Exclude<K, E[number][0]> extends never ? E : never

export const match = <K extends MatchKey, const E extends ReadonlyArray<readonly [K, AnyGrammar]>>(
  scrutinee: Ref<K>,
  entries: CompleteEntries<K, E>,
): Grammar<EntryOutput<E>, DomainOf<E[number][1]>> =>
  make({ _tag: "Match", scrutinee: assertInScope(scrutinee, "match"), cases: cases(entries, "match") })

// The branches are disjoint (the first refuses undefined, the second accepts only undefined),
// so a round-trip print check would be pure cost. The label never fails, so it only names it.
export const optional = <A, D extends Domain>(inner: Grammar<A, D>): Grammar<A | undefined, D> =>
  label("optional")(
    make({
      _tag: "Choice",
      options: [transformNode(inner, { decode: Result.succeed, encode: presentOnly<A> }), as(undefined)(empty)],
      print: "first",
    }),
  )

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
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
}

export interface TransformOrFailOptions<A, B> {
  readonly decode: (a: A) => Result.Result<B, string>
  readonly encode: (b: B) => Result.Result<A, string>
}

export const transformNode = <A, B, D extends Domain>(
  inner: Grammar<A, D>,
  options: TransformOrFailOptions<A, B>,
): Grammar<B, D> => make({ _tag: "Transform", inner, ...options })

export const transform =
  <A, B>(options: TransformOptions<A, B>) => <D extends Domain>(inner: Grammar<A, D>): Grammar<B, D> =>
    transformNode(inner, {
      decode: (value) => Result.succeed(options.decode(value)),
      encode: (value) => Result.succeed(options.encode(value)),
    })

export const transformOrFail =
  <A, B>(options: TransformOrFailOptions<A, B>) => <D extends Domain>(inner: Grammar<A, D>): Grammar<B, D> =>
    transformNode(inner, options)

export function filter<A, B extends A>(
  refinement: (value: A) => value is B,
  name: string,
): <I extends A, D extends Domain>(inner: Grammar<I, D>) => Grammar<I & B, D>
export function filter<A>(
  predicate: (value: A) => boolean,
  name: string,
): <I extends A, D extends Domain>(inner: Grammar<I, D>) => Grammar<I, D>
export function filter<A>(predicate: (value: A) => boolean, name: string) {
  return <I extends A, D extends Domain>(inner: Grammar<I, D>): Grammar<I, D> => {
    const check = (value: I) => (predicate(value) ? Result.succeed(value) : Result.fail(name))
    return transformNode(inner, { decode: check, encode: check })
  }
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
