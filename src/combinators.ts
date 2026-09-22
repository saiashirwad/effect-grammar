import { Function as F, Predicate, Result, type Types } from "effect"

import {
  type AnyGrammar,
  type Denote,
  type Expr,
  type Fidelity,
  type Grammar,
  type GrammarIssue,
  isCount,
  isGrammar,
  isSilent,
  make,
  type MatchKey,
  nodeOf,
  type Node,
  type Ref,
  type ScopeId,
  type Silent,
  silent,
  type Step,
  type Type,
} from "./core.ts"
import { exceptionMessage, preview } from "./errors.ts"
import { assertEachBindingReturnedOnce, assertInScope, refFor, type Scope, toPattern } from "./ref.ts"
import { describe } from "./render.ts"

export { get } from "./ref.ts"

// ---------------------------------------------------------------------------
// Atoms

export const literal = (value: string): Silent => silent({ _tag: "Literal", value })

export const empty = literal("")

const toSilent = (value: Silent | string): Silent => (Predicate.isString(value) ? literal(value) : value)

// Match at the parser's current cursor using JavaScript `RegExp` semantics.
// Parsing uses a fresh sticky matcher against the original full input; printing
// requires the supplied string to match in full. `g`, `y`, and the caller's
// `lastIndex` are ignored, and the caller's expression is never mutated.
export const regex = (expression: RegExp, name: string): Grammar<string> =>
  make({ _tag: "Regex", source: expression.source, flags: expression.flags.replace(/[gy]/g, ""), name })

const countExpr = (count: Ref<number> | number, where: string): Expr => {
  if (!Predicate.isNumber(count)) return assertInScope(count, where)
  if (!isCount(count)) throw new RangeError(`${where}: count must be a non-negative safe integer`)
  return { _tag: "Const", value: count }
}

export const take = (count: Ref<number> | number): Grammar<string> =>
  make({ _tag: "Take", count: countExpr(count, "take"), unit: "char" })

export const takeBytes = (count: Ref<number> | number, name?: string): Grammar<string> =>
  make({ _tag: "Take", count: countExpr(count, "bytes"), unit: "byte", name })

// ---------------------------------------------------------------------------
// Sequencing

export type GenGrammar<R> = [R] extends [void] ? Silent : Grammar<Denote<R>>

// Run the generator once at construction time. Each yielded grammar becomes a step; a
// non-silent step binds a slot and hands back a ref to it. The return value becomes the pattern.
export const gen = <R>(run: () => Generator<AnyGrammar, R, unknown>): GenGrammar<R> => {
  const iterator = run()
  const steps: Array<Step> = []
  const scope: Scope = { id: { _tag: "ScopeId" }, open: true }
  let slotCount = 0

  try {
    let result = iterator.next()
    while (!result.done) {
      const grammar = result.value
      if (!isGrammar(grammar)) throw new TypeError("gen: only a grammar can be yielded")
      if (isSilent(grammar)) {
        steps.push({ _tag: "Silent", grammar })
        result = iterator.next()
      } else {
        const slot = slotCount++
        steps.push({ _tag: "Bind", slot, grammar })
        result = iterator.next(refFor({ _tag: "Ref", scope: scope.id, slot }, scope))
      }
    }

    const pattern = toPattern(result.value)
    assertEachBindingReturnedOnce(scope.id, steps, pattern)
    const node: Node = { _tag: "Gen", scope: scope.id, slotCount, steps, result: pattern }
    const bare = pattern._tag === "Const" && pattern.value === undefined
    // SAFETY: an undefined Const selects Silent; other patterns select Grammar.
    return (bare ? silent(node) : make(node)) as GenGrammar<R>
  } finally {
    scope.open = false
  }
}

export const seq = (...parts: ReadonlyArray<Silent>): Silent =>
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
    slotCount: entries.length,
    steps: entries.map(([, grammar], slot) => ({ _tag: "Bind", slot, grammar })),
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
    slotCount: elements.length,
    steps: elements.map((grammar, slot) => ({ _tag: "Bind", slot, grammar })),
    result: { _tag: "Array", items: elements.map((_, slot) => ({ _tag: "Ref", scope, slot })) },
  })
}

// Parse the silent grammar and produce a constant; print the constant as that grammar.
export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(2, <const V>(inner: Silent, value: V) =>
  make<V>({
    _tag: "Gen",
    scope: { _tag: "ScopeId" },
    slotCount: 0,
    steps: [{ _tag: "Silent", grammar: inner }],
    result: { _tag: "Const", value },
  }),
)

type PreserveGrammar<G extends AnyGrammar> = G extends Silent ? Silent : G extends Grammar<infer A> ? Grammar<A> : never

// SAFETY: the node is silent exactly when its inner grammar is.
const like = <G extends AnyGrammar>(inner: G, node: Node): PreserveGrammar<G> =>
  (isSilent(inner) ? silent(node) : make(node)) as PreserveGrammar<G>

export function between(
  open: Silent | string,
  close: Silent | string,
): <G extends AnyGrammar>(inner: G) => PreserveGrammar<G>
export function between(open: Silent | string, inner: Silent, close: Silent | string): Silent
export function between<A>(open: Silent | string, inner: Grammar<A>, close: Silent | string): Grammar<A>
export function between<A>(open: Silent | string, innerOrClose: Grammar<A> | Silent | string, close?: Silent | string) {
  if (close === undefined) {
    // SAFETY: the two-argument overload accepts only a Silent or string here.
    const closing = toSilent(innerOrClose as Silent | string)
    return (inner: Grammar<A>) => between(open, inner, closing)
  }
  // SAFETY: the three-argument overload requires a Grammar as its second argument.
  const inner = innerOrClose as Grammar<A>
  return like(inner, { _tag: "Wrap", open: toSilent(open), inner, close: toSilent(close) })
}

export function prefix(open: Silent | string): <G extends AnyGrammar>(inner: G) => PreserveGrammar<G>
export function prefix(open: Silent | string, inner: Silent): Silent
export function prefix<A>(open: Silent | string, inner: Grammar<A>): Grammar<A>
export function prefix<A>(open: Silent | string, inner?: Grammar<A>) {
  return inner === undefined ? between(open, empty) : between(open, inner, empty)
}

export function suffix(close: Silent | string): <G extends AnyGrammar>(inner: G) => PreserveGrammar<G>
export function suffix(inner: Silent, close: Silent | string): Silent
export function suffix<A>(inner: Grammar<A>, close: Silent | string): Grammar<A>
export function suffix<A>(innerOrClose: Grammar<A> | Silent | string, close?: Silent | string) {
  if (close === undefined) {
    // SAFETY: the one-argument overload accepts only a Silent or string here.
    return between(empty, innerOrClose as Silent | string)
  }
  // SAFETY: the two-argument overload requires a Grammar as its first argument.
  return between(empty, innerOrClose as Grammar<A>, close)
}

export const keysOf = (grammar: AnyGrammar): ReadonlyArray<string> | undefined => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Gen":
      return node.result._tag === "Object" ? node.result.fields.map(([key]) => key) : undefined
    case "Transform":
      return node.keys
    case "Merge":
      return node.parts.flatMap((part) => part.keys)
    case "Wrap":
    case "Label":
      return keysOf(node.inner)
    default:
      return undefined
  }
}

const assertUniqueKeys = (keys: ReadonlyArray<MatchKey>, where: string): void => {
  const seen = new Set<MatchKey>()
  for (const key of keys) {
    if (seen.has(key)) throw new RangeError(`${where}: duplicate key ${preview(key)}`)
    seen.add(key)
  }
}

type MergeValue<Parts extends ReadonlyArray<AnyGrammar>> =
  Types.UnionToIntersection<{ [K in keyof Parts]: { readonly value: Type<Parts[K]> } }[number]> extends {
    readonly value: infer Value
  }
    ? Types.Simplify<Value>
    : never

export const merge = <const Parts extends readonly [AnyGrammar, ...Array<AnyGrammar>]>(
  ...grammars: Parts
): Grammar<MergeValue<Parts>> => {
  const parts = grammars.map((grammar, index) => {
    const keys = keysOf(grammar)
    if (keys === undefined) {
      throw new TypeError(
        `merge: part ${index + 1} (${describe(grammar)}) has no known fields; pass a struct, a gen that returns an object, another merge, or Binary.bits`,
      )
    }
    return { grammar, keys }
  })
  assertUniqueKeys(
    parts.flatMap((part) => part.keys),
    "merge",
  )
  return make({ _tag: "Merge", parts })
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

type OnCases<Tag extends string, Cases extends Readonly<Record<string, AnyGrammar>>> = {
  readonly [K in keyof Cases & string]: Type<Cases[K]> extends Readonly<Record<Tag, K>>
    ? Cases[K]
    : Grammar<Readonly<Record<Tag, K>>>
}

type OnEntries<Tag extends string, E extends Entries> = {
  readonly [I in keyof E]: E[I] extends readonly [infer K extends MatchKey, unknown]
    ? Type<E[I][1]> extends Readonly<Record<Tag, K>>
      ? E[I]
      : readonly [K, Grammar<Readonly<Record<Tag, K>>>]
    : never
}

// JavaScript reorders integer-like keys, so a record cannot carry parse order for them.
const isArrayIndexKey = (key: string): boolean => {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key
}

const dispatch = <A>(tag: string, entries: Entries, where: string): Grammar<A> => {
  if (entries.length === 0) throw new RangeError(`${where}: at least one case is required`)
  assertUniqueKeys(
    entries.map(([key]) => key),
    where,
  )
  return make({ _tag: "Dispatch", tag, cases: entries.map(([key, grammar]) => ({ key, grammar })) })
}

// Parse branches in order; print with the branch keyed by `value[tag]`.
// Branches may still parse the same text. Use `choiceOnEntries` for
// integer-like, number, or boolean keys.
export const choiceOn = <const Tag extends string, const Cases extends Readonly<Record<string, AnyGrammar>>>(
  tag: Tag,
  cases: Cases & OnCases<Tag, Cases>,
): Grammar<Type<Cases[keyof Cases]>> =>
  dispatch(
    tag,
    Object.keys(cases).map((key) => {
      if (isArrayIndexKey(key)) {
        throw new RangeError(
          `choiceOn: key ${JSON.stringify(key)} looks like an integer; JavaScript reorders such keys, so parse order would not match the source. Use choiceOnEntries instead.`,
        )
      }
      return [key, cases[key]!] as const
    }),
    "choiceOn",
  )

// `choiceOn` with `[key, grammar]` entries in parse order.
export const choiceOnEntries = <const Tag extends string, const E extends Entries>(
  tag: Tag,
  entries: E & OnEntries<Tag, E>,
): Grammar<Type<E[number][1]>> => dispatch(tag, entries, "choiceOnEntries")

type TaggedValue<Tag extends string, Cases extends Readonly<Record<string, AnyGrammar>>> = {
  readonly [K in keyof Cases & string]: Readonly<Record<Tag, K>> & { readonly value: Type<Cases[K]> }
}[keyof Cases & string]

// Wrap each case's value as `{ [tag]: key, value }` and dispatch on the tag.
export const taggedChoice = <const Tag extends string, const Cases extends Readonly<Record<string, AnyGrammar>>>(
  tag: Tag extends "value" ? never : Tag,
  cases: Cases,
): Grammar<TaggedValue<Tag, Cases>> => {
  if (tag === "value") throw new RangeError('taggedChoice: tag name "value" is reserved')
  const entries = Object.keys(cases).map((key) => {
    if (isArrayIndexKey(key)) {
      throw new RangeError(
        `taggedChoice: key ${JSON.stringify(key)} is an array index; JavaScript reorders such keys, so parse order would not match the source`,
      )
    }
    // SAFETY: the Cases constraint requires every case to be a grammar.
    const branch = transformNode(
      cases[key] as Grammar<Type<Cases[keyof Cases]>>,
      {
        decode: (value) => Result.succeed({ [tag]: key, value }),
        encode: (value) => {
          if (!Predicate.isObject(value) || !Object.hasOwn(value, tag) || value[tag] !== key) {
            return Result.fail({ message: `expected an object with ${tag} equal to ${preview(key)}` })
          }
          if (!Object.hasOwn(value, "value")) {
            return Result.fail({ message: "expected an object with a value field" })
          }
          return Result.succeed(value.value)
        },
        name: `${tag}=${preview(key)}`,
      },
      "claimed-iso",
    )
    return [key, branch] as const
  })
  return dispatch(tag, entries, "taggedChoice")
}

type FiniteString<K extends string> = string extends K ? never : K

type CaseOutput<Cases> = Cases extends Readonly<Record<PropertyKey, AnyGrammar>> ? Type<Cases[keyof Cases]> : never

// Parse and print the case selected by a value bound earlier in the same gen.
export const match = <K extends string, const Cases extends Readonly<Record<K, AnyGrammar>>>(
  scrutinee: Ref<FiniteString<K>>,
  cases: Cases,
): Grammar<CaseOutput<Cases>> =>
  make({
    _tag: "Match",
    scrutinee: assertInScope(scrutinee, "match"),
    // SAFETY: Object.keys returns only keys from the closed Cases record.
    cases: Object.keys(cases).map((key) => ({ key, grammar: cases[key as K] })),
  })

type CompleteEntries<K extends MatchKey, E extends Entries> = Exclude<K, E[number][0]> extends never ? E : never

// `match` with `[key, grammar]` entries, for number and boolean keys.
export const matchValue = <K extends MatchKey, const E extends ReadonlyArray<readonly [K, AnyGrammar]>>(
  scrutinee: Ref<K>,
  entries: CompleteEntries<K, E>,
): Grammar<Type<E[number][1]>> => {
  assertUniqueKeys(
    entries.map(([key]) => key),
    "matchValue",
  )
  return make({
    _tag: "Match",
    scrutinee: assertInScope(scrutinee, "matchValue"),
    cases: entries.map(([key, grammar]) => ({ key, grammar })),
  })
}

// ---------------------------------------------------------------------------
// Repetition

type OptionalGrammar<G extends AnyGrammar> = G extends Silent
  ? Silent
  : G extends Grammar<infer A>
    ? Grammar<A | undefined>
    : never

export const optional = <G extends AnyGrammar>(inner: G): OptionalGrammar<G> =>
  // SAFETY: a silent inner stays silent; any other inner gains `undefined`.
  like(inner, { _tag: "Optional", inner }) as OptionalGrammar<G>

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const repeatNode = <A>(
  where: string,
  inner: Grammar<A>,
  sep: Silent,
  options: RepeatOptions | undefined,
): Grammar<ReadonlyArray<A>> => {
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

const dataFirst = (args: IArguments): boolean => isGrammar(args[0])

// Repeat an item within bounds. Each item must consume input.
export const many: {
  <A>(inner: Grammar<A>, options?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (options?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(dataFirst, <A>(inner: Grammar<A>, options?: RepeatOptions) => repeatNode("many", inner, empty, options))

// Repeat an item with a silent separator between items.
export const sepBy: {
  <A>(inner: Grammar<A>, separator: Silent | string, options?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (separator: Silent | string, options?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(dataFirst, <A>(inner: Grammar<A>, separator: Silent | string, options?: RepeatOptions) =>
  repeatNode("sepBy", inner, toSilent(separator), options),
)

// Repeat an item exactly `count` times, where `count` may be a value bound earlier in the same gen.
export const repeat: {
  <A>(inner: Grammar<A>, count: Ref<number> | number): Grammar<ReadonlyArray<A>>
  (count: Ref<number> | number): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(2, <A>(inner: Grammar<A>, count: Ref<number> | number) => {
  const expr = countExpr(count, "repeat")
  return make({ _tag: "Repeat", inner, sep: empty, min: expr, max: expr })
})

// ---------------------------------------------------------------------------
// Transforms

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  readonly is?: ((value: B) => boolean) | undefined
  readonly name?: string | undefined
}

export interface TransformOrFailOptions<A, B> {
  readonly decode: (a: A) => Result.Result<B, GrammarIssue>
  readonly encode: (b: B) => Result.Result<A, GrammarIssue>
  readonly is?: ((value: B) => boolean) | undefined
  readonly name?: string | undefined
}

export const transformNode = <A, B>(
  inner: Grammar<A>,
  options: TransformOrFailOptions<A, B>,
  fidelity: Fidelity,
  keys?: ReadonlyArray<string>,
): Grammar<B> => make({ _tag: "Transform", inner, ...options, fidelity, keys })

const attempt =
  <A, B>(run: (a: A) => B) =>
  (a: A): Result.Result<B, GrammarIssue> => {
    try {
      return Result.succeed(run(a))
    } catch (error) {
      return Result.fail({ message: exceptionMessage(error) })
    }
  }

const throwingTransformNode = <A, B>(
  inner: Grammar<A>,
  options: TransformOptions<A, B>,
  fidelity: Fidelity,
  keys?: ReadonlyArray<string>,
): Grammar<B> =>
  transformNode(inner, { ...options, decode: attempt(options.decode), encode: attempt(options.encode) }, fidelity, keys)

// Transform values without claiming the functions are inverses. Printed text
// may parse back to a different value. Use `iso` to claim inverses.
export const transform: {
  <A, B>(options: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>) =>
  throwingTransformNode(inner, options, "unchecked"),
)

// `transform` with directions that return a `Result`. No law is claimed.
export const transformOrFail: {
  <A, B>(options: TransformOrFailOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>) =>
  transformNode(inner, options, "unchecked"),
)

// Like `transform`, but claims the functions are inverses. This is not
// verified; `Grammar.auditFidelity` only reports transforms without this claim.
export const iso: {
  <A, B>(options: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>) =>
  throwingTransformNode(inner, options, "claimed-iso"),
)

// An `iso` whose two directions may each fail; they must agree where both succeed.
export const partialIso: {
  <A, B>(options: TransformOrFailOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>) =>
  transformNode(inner, options, "partial"),
)

// Reject values the predicate refuses, in both directions. Keeps the inner grammar's fields for `merge`.
export const filter: {
  <A, B extends A>(refinement: (value: A) => value is B, name: string): (inner: Grammar<A>) => Grammar<B>
  <A>(predicate: (value: A) => boolean, name: string): (inner: Grammar<A>) => Grammar<A>
  <A, B extends A>(inner: Grammar<A>, refinement: (value: A) => value is B, name: string): Grammar<B>
  <A>(inner: Grammar<A>, predicate: (value: A) => boolean, name: string): Grammar<A>
} = F.dual(3, <A>(inner: Grammar<A>, predicate: (value: A) => boolean, name: string) =>
  throwingTransformNode(
    inner,
    { decode: F.identity, encode: F.identity, is: predicate, name },
    "claimed-iso",
    keysOf(inner),
  ),
)

// Parse the inner grammar but drop its value; print `printAs` in its place.
export const skip: {
  <A>(printAs: A): (inner: Grammar<A>) => Silent
  <A>(inner: Grammar<A>, printAs: A): Silent
} = F.dual(2, <A>(inner: Grammar<A>, printAs: A) => silent({ _tag: "Skip", inner, printAs, hidden: false }))

// Report `name` instead of the inner grammar's expectations when parsing fails at its start.
export const label: {
  (name: string): <A>(inner: Grammar<A>) => Grammar<A>
  <A>(inner: Grammar<A>, name: string): Grammar<A>
} = F.dual(2, <A>(inner: Grammar<A>, name: string) => make({ _tag: "Label", inner, name }))

// ---------------------------------------------------------------------------
// Recursion

// Resolve and cache the thunk on first use. Parsing rejects recursion at the
// same input position; printing rejects revisiting the same suspension without
// consuming a value.
export const suspend = <A>(thunk: () => Grammar<A>, name?: string): Grammar<A> => make({ _tag: "Suspend", thunk, name })

// ---------------------------------------------------------------------------
// Whitespace

const hiddenWhitespace = (expression: RegExp, name: string, printAs: string): Silent =>
  silent({ _tag: "Skip", inner: regex(expression, name), printAs, hidden: true })

export const trivia = hiddenWhitespace(/\s*/, "trivia", "")
export const space = literal(" ")
export const spaces = hiddenWhitespace(/\s+/, "whitespace", " ")
