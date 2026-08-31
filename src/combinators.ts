import { Equal, Function as F, Predicate, Result, Schema } from "effect"

import {
  type Bounds,
  type Grammar,
  type GrammarInternal,
  type Fidelity,
  type GrammarIssue,
  isGrammar,
  isSilent,
  make,
  type MatchKey,
  type Node,
  type Ref,
  type ScopeId,
  type Silent,
  silent,
  type Type,
} from "./core.ts"
import { isCount } from "./env.ts"
import { exceptionMessage, preview } from "./errors.ts"
import { assertInScope } from "./gen.ts"

export { gen, type GenGrammar, get, seq } from "./gen.ts"

export const literal = (value: string): Silent => silent({ _tag: "Literal", value })

export const empty = literal("")

export const regex = (expression: RegExp, name: string): Grammar<string> => {
  const flags = expression.flags.replace(/[gy]/g, "")
  return make({ _tag: "Regex", re: new RegExp(expression.source, `${flags}y`), name })
}

const toSilent = (value: Silent | string): Silent =>
  Predicate.isString(value) ? literal(value) : value

const preserveSilence = <A>(inner: Grammar<A>, node: Node): Grammar<A> | Silent => {
  if (isSilent(inner)) return silent(node)
  return make<A>(node)
}

type PreserveGrammar<G extends GrammarInternal> = G extends Silent
  ? Silent
  : G extends Grammar<infer A>
    ? Grammar<A>
    : never

type OptionalGrammar<G extends GrammarInternal> = G extends Silent
  ? Silent
  : G extends Grammar<infer A>
    ? Grammar<A | undefined>
    : never

export function between(
  open: Silent | string,
  close: Silent | string,
): <G extends GrammarInternal>(inner: G) => PreserveGrammar<G>
export function between(open: Silent | string, inner: Silent, close: Silent | string): Silent
export function between<A>(
  open: Silent | string,
  inner: Grammar<A>,
  close: Silent | string,
): Grammar<A>
export function between<A>(
  open: Silent | string,
  innerOrClose: Grammar<A> | Silent | string,
  close?: Silent | string,
) {
  if (close === undefined) {
    // SAFETY: the two-argument overload accepts only a Silent or string here.
    const closing = toSilent(innerOrClose as Silent | string)
    return (inner: Grammar<A>) => between(open, inner, closing)
  }
  // SAFETY: the three-argument overload requires a Grammar as its second argument.
  const inner = innerOrClose as Grammar<A>
  return preserveSilence(inner, {
    _tag: "Wrap",
    open: toSilent(open),
    inner,
    close: toSilent(close),
  })
}

export const wrap = between

export function prefix(
  open: Silent | string,
): <G extends GrammarInternal>(inner: G) => PreserveGrammar<G>
export function prefix(open: Silent | string, inner: Silent): Silent
export function prefix<A>(open: Silent | string, inner: Grammar<A>): Grammar<A>
export function prefix<A>(open: Silent | string, inner?: Grammar<A>) {
  return inner === undefined
    ? (value: Grammar<A>) => between(open, value, empty)
    : between(open, inner, empty)
}

export function suffix(
  close: Silent | string,
): <G extends GrammarInternal>(inner: G) => PreserveGrammar<G>
export function suffix(inner: Silent, close: Silent | string): Silent
export function suffix<A>(inner: Grammar<A>, close: Silent | string): Grammar<A>
export function suffix<A>(innerOrClose: Grammar<A> | Silent | string, close?: Silent | string) {
  if (close === undefined) {
    // SAFETY: the one-argument overload accepts only a Silent or string here.
    return (inner: Grammar<A>) => between(empty, inner, innerOrClose as Silent | string)
  }
  // SAFETY: the two-argument overload requires a Grammar as its first argument.
  return between(empty, innerOrClose as Grammar<A>, close)
}

/**
 * Ordered alternatives. Parsing tries each branch in order and keeps the
 * first that matches. Printing keeps the first branch whose printer accepts
 * the value; use `checkedChoice` to keep the first branch whose text also
 * parses back.
 */
export const choice = <
  const Grammars extends readonly [GrammarInternal, ...Array<GrammarInternal>],
>(
  ...options: Grammars
): Grammar<Type<Grammars[number]>> => make({ _tag: "Choice", options })

/**
 * {@link choice} whose printer selects the first branch that reads back to an
 * equal value. Reparses at every nested `choice`; keep it off hot paths.
 */
export const checkedChoice = <
  const Grammars extends readonly [GrammarInternal, ...Array<GrammarInternal>],
>(
  ...options: Grammars
): Grammar<Type<Grammars[number]>> => make({ _tag: "Choice", options, checked: true })

export function optional(): <G extends GrammarInternal>(inner: G) => OptionalGrammar<G>
export function optional(inner: Silent): Silent
export function optional<A>(inner: Grammar<A>): Grammar<A | undefined>
export function optional<A>(inner?: Grammar<A>) {
  if (inner === undefined) return (value: Grammar<A>) => optional(value)
  return preserveSilence(inner, { _tag: "Optional", inner })
}

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const bounds = (name: string, options: RepeatOptions | undefined): Bounds => {
  const min = options?.min ?? 0
  const max = options?.max ?? Number.POSITIVE_INFINITY
  if (!isCount(min)) throw new RangeError(`${name}: min must be a non-negative safe integer`)
  if (max !== Number.POSITIVE_INFINITY && (!isCount(max) || max < min)) {
    throw new RangeError(`${name}: max must be a safe integer >= min`)
  }
  return { min, max }
}

const dataFirst = (args: IArguments): boolean => isGrammar(args[0])

const repeatNode = <A>(
  name: string,
  inner: Grammar<A>,
  separator: Silent,
  options: RepeatOptions | undefined,
): Grammar<ReadonlyArray<A>> =>
  make({ _tag: "Many", inner, sep: separator, ...bounds(name, options) })

export const many: {
  <A>(inner: Grammar<A>, options?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (options?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(dataFirst, <A>(inner: Grammar<A>, options?: RepeatOptions) =>
  repeatNode("many", inner, empty, options),
)

export const sepBy: {
  <A>(
    inner: Grammar<A>,
    separator: Silent | string,
    options?: RepeatOptions,
  ): Grammar<ReadonlyArray<A>>
  (
    separator: Silent | string,
    options?: RepeatOptions,
  ): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(dataFirst, <A>(inner: Grammar<A>, separator: Silent | string, options?: RepeatOptions) =>
  repeatNode("sepBy", inner, toSilent(separator), options),
)

type FiniteString<K extends string> = string extends K ? never : K

type CaseOutput<Cases> =
  Cases extends Readonly<Record<PropertyKey, GrammarInternal>> ? Type<Cases[keyof Cases]> : never

export const match = <K extends string, const Cases extends Readonly<Record<K, GrammarInternal>>>(
  scrutinee: Ref<FiniteString<K>>,
  cases: Cases,
): Grammar<CaseOutput<Cases>> =>
  make({
    _tag: "Match",
    scrutinee: assertInScope(scrutinee, "match"),
    // SAFETY: Object.keys returns only keys from the closed Cases record.
    cases: Object.keys(cases).map((key) => ({ key, grammar: cases[key as K] })),
  })

const uniqueCases = (
  entries: ReadonlyArray<readonly [MatchKey, GrammarInternal]>,
): ReadonlyArray<{ readonly key: MatchKey; readonly grammar: GrammarInternal }> => {
  assertUniqueKeys(
    entries.map(([key]) => key),
    "matchValue",
  )
  return entries.map(([key, grammar]) => ({ key, grammar }))
}

type EntryOutput<Entries extends ReadonlyArray<readonly [MatchKey, GrammarInternal]>> = Type<
  Entries[number][1]
>

type CompleteEntries<
  K extends MatchKey,
  Entries extends ReadonlyArray<readonly [MatchKey, GrammarInternal]>,
> = Exclude<K, Entries[number][0]> extends never ? Entries : never

export const matchValue = <
  K extends MatchKey,
  const Entries extends ReadonlyArray<readonly [K, GrammarInternal]>,
>(
  scrutinee: Ref<K>,
  entries: CompleteEntries<K, Entries>,
): Grammar<EntryOutput<Entries>> =>
  make({
    _tag: "Match",
    scrutinee: assertInScope(scrutinee, "matchValue"),
    cases: uniqueCases(entries),
  })

export const take = (count: Ref<number>): Grammar<string> =>
  make({ _tag: "Take", count: assertInScope(count, "take") })

export const repeat: {
  <A>(inner: Grammar<A>, count: Ref<number>): Grammar<ReadonlyArray<A>>
  (count: Ref<number>): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(dataFirst, <A>(inner: Grammar<A>, count: Ref<number>) =>
  make({ _tag: "RepeatExact", count: assertInScope(count, "repeat"), inner }),
)

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  readonly is?: (value: B) => boolean
  readonly name?: string
}

const attempt =
  <A, B>(decode: (a: A) => B) =>
  (a: A): Result.Result<B, GrammarIssue> => {
    try {
      return Result.succeed(decode(a))
    } catch (error) {
      return Result.fail({ message: exceptionMessage(error) })
    }
  }

const plainTransform = <A, B>(
  inner: Grammar<A>,
  options: TransformOptions<A, B>,
  fidelity: Fidelity,
): Grammar<B> =>
  make({
    _tag: "Transform",
    inner,
    decode: attempt(options.decode),
    encode: attempt(options.encode),
    is: options.is,
    name: options.name,
    fidelity,
  })

const resultTransform = <A, B>(
  inner: Grammar<A>,
  options: TransformOrFailOptions<A, B>,
  fidelity: Fidelity,
): Grammar<B> => make({ _tag: "Transform", inner, ...options, fidelity })

/**
 * Map a grammar's value with a pair of functions. No law is claimed: the
 * two directions need not be inverse, so a value may print as text that
 * parses back to something else. Use `iso` when you mean to claim inverses.
 */
export const transform: {
  <A, B>(options: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>) =>
  plainTransform(inner, options, "unchecked"),
)

export interface TransformOrFailOptions<A, B> {
  readonly decode: (a: A) => Result.Result<B, GrammarIssue>
  readonly encode: (b: B) => Result.Result<A, GrammarIssue>
  readonly is?: (value: B) => boolean
  readonly name?: string
}

/** {@link transform} with directions that return a `Result`. No law is claimed. */
export const transformOrFail: {
  <A, B>(options: TransformOrFailOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>) =>
  resultTransform(inner, options, "unchecked"),
)

/**
 * Like {@link transform}, but the author claims the two directions are
 * inverse. The claim is recorded, not proved; `Grammar.auditFidelity` reports
 * only the transforms that make no such claim.
 */
export const iso: {
  <A, B>(options: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOptions<A, B>) =>
  plainTransform(inner, options, "claimed-iso"),
)

/** An {@link iso} whose two directions may each fail; they must agree where both succeed. */
export const partialIso: {
  <A, B>(options: TransformOrFailOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, options: TransformOrFailOptions<A, B>) =>
  resultTransform(inner, options, "partial"),
)

export interface DecodeToOptions<A, T> extends Omit<TransformOptions<A, T>, "is"> {
  readonly is?: ((value: T) => boolean) | undefined
}

export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(options: DecodeToOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> => {
    let guard: ((value: T) => boolean) | undefined
    return iso(inner, {
      ...options,
      is: options.is ?? ((value) => (guard ??= Schema.is(schema))(value)),
    })
  }

export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(2, <const V>(inner: Silent, value: V) =>
  iso(inner, {
    decode: () => value,
    encode: () => undefined,
    is: (input) => Equal.equals(input, value),
    name: preview(value),
  }),
)

export const flag = (value: Silent | string): Grammar<boolean> =>
  choice(as(toSilent(value), true), as(empty, false))

export const skip: {
  <A>(printAs: A): (inner: Grammar<A>) => Silent
  <A>(inner: Grammar<A>, printAs: A): Silent
} = F.dual(2, <A>(inner: Grammar<A>, printAs: A) =>
  silent({ _tag: "Skip", inner, printAs, show: true }),
)

export const label: {
  (name: string): <A>(inner: Grammar<A>) => Grammar<A>
  <A>(inner: Grammar<A>, name: string): Grammar<A>
} = F.dual(2, <A>(inner: Grammar<A>, name: string) => make({ _tag: "Label", inner, name }))

export const suspend = <A>(thunk: () => Grammar<A>, name?: string): Grammar<A> =>
  make({ _tag: "Suspend", thunk, name })

export const defaulted: {
  <A>(value: A): (inner: Grammar<A | undefined>) => Grammar<A>
  <A>(inner: Grammar<A | undefined>, value: A): Grammar<A>
} = F.dual(dataFirst, <A>(inner: Grammar<A | undefined>, value: A) =>
  iso(inner, {
    decode: (input) => input ?? value,
    encode: (input) => (Equal.equals(input, value) ? undefined : input),
  }),
)

type StructFields = Readonly<Record<string, GrammarInternal>>

type StructValue<Fields extends StructFields> = {
  readonly [K in keyof Fields]: Type<Fields[K]>
}

export const struct = <const Fields extends StructFields>(
  fields: Fields,
): Grammar<StructValue<Fields>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  const entries = Object.entries(fields)
  return make({
    _tag: "Gen",
    scope,
    slotCount: entries.length,
    steps: entries.map(([, grammar], slot) => ({ _tag: "Bind", slot, grammar })),
    result: {
      _tag: "Object",
      fields: entries.map(([key], slot) => [key, { _tag: "Ref", scope, slot }]),
    },
  })
}

type TupleValue<Elements extends ReadonlyArray<GrammarInternal>> = {
  readonly [K in keyof Elements]: Type<Elements[K]>
}

export const tuple = <const Elements extends ReadonlyArray<GrammarInternal>>(
  ...elements: Elements
): Grammar<TupleValue<Elements>> => {
  const scope: ScopeId = { _tag: "ScopeId" }
  return make({
    _tag: "Gen",
    scope,
    slotCount: elements.length,
    steps: elements.map((grammar, slot) => ({ _tag: "Bind", slot, grammar })),
    result: {
      _tag: "Array",
      items: elements.map((_, slot) => ({ _tag: "Ref", scope, slot })),
    },
  })
}

type OnCases<Tag extends string, Cases extends Readonly<Record<string, GrammarInternal>>> = {
  readonly [K in keyof Cases & string]: Type<Cases[K]> extends Readonly<Record<Tag, K>>
    ? Cases[K]
    : Grammar<Readonly<Record<Tag, K>>>
}

type OnEntries<
  Tag extends string,
  Entries extends ReadonlyArray<readonly [MatchKey, GrammarInternal]>,
> = {
  readonly [I in keyof Entries]: Entries[I] extends readonly [infer K extends MatchKey, unknown]
    ? Type<Entries[I][1]> extends Readonly<Record<Tag, K>>
      ? Entries[I]
      : readonly [K, Grammar<Readonly<Record<Tag, K>>>]
    : never
}

const isIntegerKey = (key: string): boolean => String(Number.parseInt(key, 10)) === key

const assertUniqueKeys = (keys: ReadonlyArray<MatchKey>, where: string): void => {
  const seen = new Set<MatchKey>()
  for (const key of keys) {
    if (seen.has(key)) throw new RangeError(`${where}: duplicate key ${preview(key)}`)
    seen.add(key)
  }
}

/**
 * Alternatives dispatched by a discriminant field. Parsing tries the branches
 * in order; printing reads `value[tag]` and prints with the branch of that key,
 * so it never picks the wrong printer. It does not remove parse ambiguity: two
 * branches may still parse the same text.
 *
 * Pass an object for string keys, or an array of `[key, grammar]` entries for
 * an explicit order and number or boolean discriminants. The object form
 * rejects integer-like keys, which JavaScript reorders.
 */
export function choiceOn<
  const Tag extends string,
  const Cases extends Readonly<Record<string, GrammarInternal>>,
>(tag: Tag, cases: Cases & OnCases<Tag, Cases>): Grammar<Type<Cases[keyof Cases]>>
export function choiceOn<
  const Tag extends string,
  const Entries extends ReadonlyArray<readonly [MatchKey, GrammarInternal]>,
>(tag: Tag, entries: Entries & OnEntries<Tag, Entries>): Grammar<Type<Entries[number][1]>>
export function choiceOn(
  tag: string,
  cases:
    | Readonly<Record<string, GrammarInternal>>
    | ReadonlyArray<readonly [MatchKey, GrammarInternal]>,
): GrammarInternal {
  const entries: ReadonlyArray<readonly [MatchKey, GrammarInternal]> = Array.isArray(cases)
    ? cases
    : Object.keys(cases).map((key) => {
        if (isIntegerKey(key)) {
          throw new RangeError(
            `choiceOn: key ${JSON.stringify(key)} looks like an integer; JavaScript reorders such keys, so parse order would not match the source. Pass an array of [key, grammar] entries instead.`,
          )
        }
        // SAFETY: Array.isArray ruled out the entries form, so cases is the record here.
        return [key, (cases as Readonly<Record<string, GrammarInternal>>)[key]!] as const
      })
  if (entries.length === 0) throw new RangeError("choiceOn: at least one case is required")
  const keys = entries.map(([key]) => key)
  assertUniqueKeys(keys, "choiceOn")
  return make({
    _tag: "Choice",
    options: entries.map(([, grammar]) => grammar),
    on: { tag, keys },
  })
}

type TaggedValue<Tag extends string, Cases extends Readonly<Record<string, GrammarInternal>>> = {
  readonly [K in keyof Cases & string]: Readonly<Record<Tag, K>> & {
    readonly value: Type<Cases[K]>
  }
}[keyof Cases & string]

export const taggedChoice = <
  const Tag extends string,
  const Cases extends Readonly<Record<string, GrammarInternal>>,
>(
  tag: Tag,
  cases: Cases,
): Grammar<TaggedValue<Tag, Cases>> => {
  const keys = Object.keys(cases)
  if (keys.length === 0) throw new RangeError("taggedChoice: at least one case is required")
  const branches = keys.map((key) =>
    make({
      _tag: "Transform",
      inner: cases[key]!,
      decode: (value) => Result.succeed({ [tag]: key, value }),
      encode: (value) => Result.succeed(Object(value).value),
      name: `${tag}=${preview(key)}`,
      fidelity: "claimed-iso",
    }),
  )
  return make({ _tag: "Choice", options: branches, on: { tag, keys } })
}

const hiddenWhitespace = (expression: RegExp, name: string, printAs: string): Silent =>
  silent({ _tag: "Skip", inner: regex(expression, name), printAs, show: false })

export const trivia = hiddenWhitespace(/\s*/, "trivia", "")
export const space = literal(" ")
export const spaces = hiddenWhitespace(/\s+/, "whitespace", " ")

export function lexeme(inner: Silent): Silent
export function lexeme<A>(inner: Grammar<A>): Grammar<A>
export function lexeme<A>(inner: Grammar<A>) {
  return suffix(inner, trivia)
}

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
