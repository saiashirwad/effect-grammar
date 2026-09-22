import { Predicate, Result } from "effect"

import {
  type AnyGrammar,
  type Denote,
  type Expr,
  type Fidelity,
  type Grammar,
  isCount,
  isGrammar,
  make,
  type MatchKey,
  type Ref,
  type ScopeId,
  type Type,
  type Value,
} from "./core.ts"
import { exceptionMessage, preview } from "./errors.ts"
import { assertInScope, assertRefsReturnedOnce, keysOf, refFor, type Scope, toPattern } from "./ref.ts"

export { get } from "./ref.ts"

// ---------------------------------------------------------------------------
// Atoms

export const literal = (value: string): Grammar<void> => make({ _tag: "Literal", value })

export const empty = literal("")

const toGrammar = (value: Grammar<void> | string): Grammar<void> => (Predicate.isString(value) ? literal(value) : value)

// Name the inner grammar in `render` and in parse errors where no part of it consumed input.
export const label =
  (name: string) =>
  <A>(inner: Grammar<A>): Grammar<A> =>
    make({ _tag: "Label", inner, name })

// Match at the parser's current cursor using JavaScript `RegExp` semantics.
// Parsing uses a fresh sticky matcher against the original full input; printing
// requires the supplied string to match in full. `g`, `y`, and the caller's
// `lastIndex` are ignored, and the caller's expression is never mutated.
export const regex = (expression: RegExp, name?: string): Grammar<string> => {
  const grammar = make<string>({
    _tag: "Regex",
    source: expression.source,
    flags: expression.flags.replace(/[gy]/g, ""),
  })
  return name === undefined ? grammar : label(name)(grammar)
}

const countExpr = (count: Ref<number> | number, where: string): Expr => {
  if (!Predicate.isNumber(count)) return assertInScope(count, where)
  if (!isCount(count)) throw new RangeError(`${where}: count must be a non-negative safe integer`)
  return { _tag: "Const", value: count }
}

// Take `count` characters, where `count` may be a value bound earlier in the same gen.
export const take = (count: Ref<number> | number): Grammar<string> =>
  make({ _tag: "Take", count: countExpr(count, "take") })

// ---------------------------------------------------------------------------
// Sequencing

// Run the generator once at construction time. Each yielded grammar becomes a step bound to
// a ref. The return value becomes the pattern; steps it does not mention print with `undefined`.
export const gen = <R>(run: () => Generator<AnyGrammar, R, unknown>): Grammar<Denote<R>> => {
  const iterator = run()
  const steps: Array<AnyGrammar> = []
  const scope: Scope = { id: { _tag: "ScopeId" }, open: true }

  try {
    let result = iterator.next()
    while (!result.done) {
      const grammar = result.value
      if (!isGrammar(grammar)) throw new TypeError("gen: only a grammar can be yielded")
      const slot = steps.push(grammar) - 1
      result = iterator.next(refFor({ _tag: "Ref", scope: scope.id, slot }, scope, keysOf(grammar)))
    }
    const pattern = toPattern(result.value)
    assertRefsReturnedOnce(scope.id, steps, pattern)
    return make({ _tag: "Gen", scope: scope.id, steps, result: pattern })
  } finally {
    scope.open = false
  }
}

export const seq = (...parts: ReadonlyArray<Grammar<void>>): Grammar<void> =>
  gen(function* () {
    for (const part of parts) yield* part
  })

type StructValue<Fields extends Readonly<Record<string, AnyGrammar>>> = {
  readonly [K in keyof Fields]: Type<Fields[K]>
}

// Sequence fields and return an object. Printing requires exactly these own
// keys: missing, extra, and symbol keys are rejected.
export const struct = <const Fields extends Readonly<Record<string, AnyGrammar>>>(
  fields: Fields,
): Grammar<StructValue<Fields>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  const entries = Object.entries(fields)
  return make({
    _tag: "Gen",
    scope,
    steps: entries.map(([, grammar]) => grammar),
    result: { _tag: "Object", fields: entries.map(([key], slot) => [key, { _tag: "Ref", scope, slot }]) },
  })
}

type TupleValue<Elements extends ReadonlyArray<AnyGrammar>> = {
  readonly [K in keyof Elements]: Type<Elements[K]>
}

export const tuple = <const Elements extends ReadonlyArray<AnyGrammar>>(
  ...elements: Elements
): Grammar<TupleValue<Elements>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  return make({
    _tag: "Gen",
    scope,
    steps: elements,
    result: { _tag: "Array", items: elements.map((_, slot) => ({ _tag: "Ref", scope, slot })) },
  })
}

// Parse the inner grammar and produce a constant; print the constant as that grammar.
export const as =
  <const V>(value: V) =>
  (inner: Grammar<void>): Grammar<V> =>
    make({ _tag: "Gen", scope: { _tag: "ScopeId" }, steps: [inner], result: { _tag: "Const", value } })

export const between =
  (open: Grammar<void> | string, close: Grammar<void> | string) =>
  <A>(inner: Grammar<A>): Grammar<A> =>
    make({ _tag: "Wrap", open: toGrammar(open), inner, close: toGrammar(close) })

export const prefix = (open: Grammar<void> | string) => between(open, empty)

export const suffix = (close: Grammar<void> | string) => between(empty, close)

const assertUniqueKeys = (keys: ReadonlyArray<MatchKey>, where: string): void => {
  const seen = new Set<MatchKey>()
  for (const key of keys) {
    if (seen.has(key)) throw new RangeError(`${where}: duplicate key ${preview(key)}`)
    seen.add(key)
  }
}

// ---------------------------------------------------------------------------
// Choice

type Options = readonly [AnyGrammar, ...Array<AnyGrammar>]

// Parse with the first matching branch; print with the first accepting printer.
export const choice = <const Grammars extends Options>(...options: Grammars): Grammar<Type<Grammars[number]>> =>
  make({ _tag: "Choice", options, checked: false })

// `choice` whose printer selects the first branch that reads back to an
// equal value. Each checked choice reparses its candidate output; nesting can
// multiply that work, so keep it off hot paths.
export const checkedChoice = <const Grammars extends Options>(...options: Grammars): Grammar<Type<Grammars[number]>> =>
  make({ _tag: "Choice", options, checked: true })

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
    ? Type<E[I][1]> extends Readonly<Record<Tag, K>>
      ? E[I]
      : readonly [K, Grammar<Readonly<Record<Tag, K>>>]
    : never
}

// Parse the cases in order; print with the case whose key equals `value[tag]`.
export const dispatch = <const Tag extends string, const E extends Entries>(
  tag: Tag,
  entries: E & TaggedEntries<Tag, E>,
): Grammar<EntryOutput<E>> => make({ _tag: "Dispatch", tag, cases: cases(entries, "dispatch") })

type TaggedValue<Tag extends string, E extends Entries> = {
  readonly [I in keyof E]: E[I] extends readonly [infer K extends MatchKey, infer G]
    ? Readonly<Record<Tag, K>> & { readonly value: Type<G> }
    : never
}[number]

// Wrap each case's value as `{ [tag]: key, value }` and dispatch on the tag.
export const taggedChoice = <const Tag extends string, const E extends Entries>(
  tag: Tag extends "value" ? never : Tag,
  entries: E,
): Grammar<TaggedValue<Tag, E>> => {
  if (tag === "value") throw new RangeError('taggedChoice: tag name "value" is reserved')
  const branches = entries.map(([key, grammar]) => {
    const branch = transformNode(
      // SAFETY: entries pair keys with grammars; only the output type is erased.
      grammar as Grammar<Value>,
      {
        decode: (value) => Result.succeed({ [tag]: key, value }),
        encode: (value) => {
          if (!Predicate.isObject(value) || !Object.hasOwn(value, tag) || value[tag] !== key) {
            return Result.fail(`expected an object with ${tag} equal to ${preview(key)}`)
          }
          if (!Object.hasOwn(value, "value")) return Result.fail("expected an object with a value field")
          return Result.succeed(value.value)
        },
      },
      "claimed-iso",
    )
    return [key, branch] as const
  })
  return make({ _tag: "Dispatch", tag, cases: cases(branches, "taggedChoice") })
}

type CompleteEntries<K extends MatchKey, E extends Entries> = Exclude<K, E[number][0]> extends never ? E : never

// Parse and print the case selected by a value bound earlier in the same gen.
export const match = <K extends MatchKey, const E extends ReadonlyArray<readonly [K, AnyGrammar]>>(
  scrutinee: Ref<K>,
  entries: CompleteEntries<K, E>,
): Grammar<EntryOutput<E>> =>
  make({ _tag: "Match", scrutinee: assertInScope(scrutinee, "match"), cases: cases(entries, "match") })

// ---------------------------------------------------------------------------
// Repetition

export const optional = <A>(inner: Grammar<A>): Grammar<A | undefined> => make({ _tag: "Optional", inner })

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const repeatNode =
  (where: string, sep: Grammar<void>, options: RepeatOptions | undefined) =>
  <A>(inner: Grammar<A>): Grammar<ReadonlyArray<A>> => {
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

// Repeat an item within bounds. Each item must consume input.
export const many = (options?: RepeatOptions) => repeatNode("many", empty, options)

// Repeat an item with a separator between items.
export const sepBy = (separator: Grammar<void> | string, options?: RepeatOptions) =>
  repeatNode("sepBy", toGrammar(separator), options)

// Repeat an item exactly `count` times, where `count` may be a value bound earlier in the same gen.
export const repeat =
  (count: Ref<number> | number) =>
  <A>(inner: Grammar<A>): Grammar<ReadonlyArray<A>> => {
    const expr = countExpr(count, "repeat")
    return make({ _tag: "Repeat", inner, sep: empty, min: expr, max: expr })
  }

// ---------------------------------------------------------------------------
// Transforms

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
}

export interface TransformOrFailOptions<A, B> {
  readonly decode: (a: A) => Result.Result<B, string>
  readonly encode: (b: B) => Result.Result<A, string>
}

export const transformNode = <A, B>(
  inner: Grammar<A>,
  options: TransformOrFailOptions<A, B>,
  fidelity: Fidelity,
  keys?: ReadonlyArray<string>,
): Grammar<B> => make({ _tag: "Transform", inner, ...options, fidelity, keys })

const attempt =
  <A, B>(run: (a: A) => B) =>
  (a: A): Result.Result<B, string> => {
    try {
      return Result.succeed(run(a))
    } catch (error) {
      return Result.fail(exceptionMessage(error))
    }
  }

const throwingTransformNode = <A, B>(
  inner: Grammar<A>,
  options: TransformOptions<A, B>,
  fidelity: Fidelity,
): Grammar<B> => transformNode(inner, { decode: attempt(options.decode), encode: attempt(options.encode) }, fidelity)

// Transform values without claiming the functions are inverses. Printed text
// may parse back to a different value. Use `iso` to claim inverses.
export const transform =
  <A, B>(options: TransformOptions<A, B>) =>
  (inner: Grammar<A>): Grammar<B> =>
    throwingTransformNode(inner, options, "unchecked")

// `transform` with directions that return a `Result`. No law is claimed.
export const transformOrFail =
  <A, B>(options: TransformOrFailOptions<A, B>) =>
  (inner: Grammar<A>): Grammar<B> =>
    transformNode(inner, options, "unchecked")

// Like `transform`, but claims the functions are inverses. This is not
// verified; `auditFidelity` only reports transforms without this claim.
export const iso =
  <A, B>(options: TransformOptions<A, B>) =>
  (inner: Grammar<A>): Grammar<B> =>
    throwingTransformNode(inner, options, "claimed-iso")

// An `iso` whose two directions may each fail; they must agree where both succeed.
export const partialIso =
  <A, B>(options: TransformOrFailOptions<A, B>) =>
  (inner: Grammar<A>): Grammar<B> =>
    transformNode(inner, options, "partial")

// Reject values the predicate refuses, in both directions, reporting `name` as what was expected.
// Keeps the inner grammar's fields, so a ref to it can still be spread.
export function filter<A, B extends A>(
  refinement: (value: A) => value is B,
  name: string,
): <I extends A>(inner: Grammar<I>) => Grammar<I & B>
export function filter<A>(
  predicate: (value: A) => boolean,
  name: string,
): <I extends A>(inner: Grammar<I>) => Grammar<I>
export function filter<A>(predicate: (value: A) => boolean, name: string) {
  return <I extends A>(inner: Grammar<I>): Grammar<I> => {
    const check = (value: I) => (predicate(value) ? Result.succeed(value) : Result.fail(name))
    return transformNode(inner, { decode: check, encode: check }, "claimed-iso", keysOf(inner))
  }
}

// Parse the inner grammar but drop its value; print `printAs` in its place.
export const skip =
  <A>(printAs: A) =>
  (inner: Grammar<A>): Grammar<void> =>
    make({ _tag: "Skip", inner, printAs, hidden: false })

// ---------------------------------------------------------------------------
// Recursion

// Resolve and cache the thunk on first use. Parsing rejects recursion at the
// same input position; printing rejects re-entering with the same value.
// `name` stands for the grammar where `render` would otherwise loop.
export const suspend = <A>(thunk: () => Grammar<A>, name?: string): Grammar<A> => make({ _tag: "Suspend", thunk, name })

// ---------------------------------------------------------------------------
// Whitespace

const hiddenWhitespace = (expression: RegExp, name: string, printAs: string): Grammar<void> =>
  make({ _tag: "Skip", inner: regex(expression, name), printAs, hidden: true })

export const trivia = hiddenWhitespace(/\s*/, "trivia", "")
export const space = literal(" ")
export const spaces = hiddenWhitespace(/\s+/, "whitespace", " ")
