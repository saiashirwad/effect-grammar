import { Function as F, Schema } from "effect"

import {
  type Bounds,
  type Field,
  FieldImpl,
  type Fields,
  type Grammar,
  isField,
  isGrammar,
  isSilent,
  make,
  type Node,
  type Part,
  type Silent,
  silent,
  type Type,
} from "./core.ts"

export const literal = (value: string): Silent => silent({ _tag: "Literal", value })

export const empty: Silent = literal("")

export const regex = (re: RegExp, name: string): Grammar<string> =>
  make({ _tag: "Regex", re: new RegExp(re.source, re.flags.replace(/[gy]/g, "")), name })

export const field = <const K extends string, G extends Grammar<any>>(
  name: K,
  grammar: G,
): Field<K, Type<G>> => new FieldImpl(name, grammar)

export const seq: {
  (...parts: ReadonlyArray<Silent>): Silent
  <const Parts extends ReadonlyArray<Silent | Field<string, any>>>(
    ...parts: Parts
  ): Grammar<Fields<Parts[number]>>
} = (...parts: ReadonlyArray<Part>): any =>
  parts.every((p) => !isField(p)) ? silent({ _tag: "Seq", parts }) : make({ _tag: "Seq", parts })

export const gen = <Y extends Silent | Field<string, any>, R extends Fields<Y> | void = void>(
  run: () => Generator<Y, R, any>,
): Grammar<[R] extends [void] ? Fields<Y> : R> => make({ _tag: "Gen", run })

const toSilent = (s: Silent | string): Silent => (typeof s === "string" ? literal(s) : s)

export const wrap: {
  (open: Silent | string, inner: Silent, close: Silent | string): Silent
  <A>(open: Silent | string, inner: Grammar<A>, close: Silent | string): Grammar<A>
} = (open: Silent | string, inner: Grammar<any>, close: Silent | string): any => {
  const node: Node = { _tag: "Wrap", open: toSilent(open), inner, close: toSilent(close) }
  return isSilent(inner) ? silent(node) : make(node)
}

export const prefix: {
  (open: Silent | string, inner: Silent): Silent
  <A>(open: Silent | string, inner: Grammar<A>): Grammar<A>
} = (open: Silent | string, inner: Grammar<any>): any => wrap(open, inner, empty)

export const suffix: {
  (inner: Silent, close: Silent | string): Silent
  <A>(inner: Grammar<A>, close: Silent | string): Grammar<A>
} = (inner: Grammar<any>, close: Silent | string): any => wrap(empty, inner, close)

export const choice = <const Gs extends readonly [Grammar<any>, ...Array<Grammar<any>>]>(
  ...options: Gs
): Grammar<Type<Gs[number]>> => make({ _tag: "Choice", options })

export const optional: {
  (inner: Silent): Silent
  <A>(inner: Grammar<A>): Grammar<A | undefined>
} = (inner: Grammar<any>): any => {
  const node: Node = { _tag: "Optional", inner }
  return isSilent(inner) ? silent(node) : make(node)
}

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const bounds = (name: string, opts: RepeatOptions | undefined): Bounds => {
  const min = opts?.min ?? 0
  const max = opts?.max ?? Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(min) || min < 0) {
    throw new RangeError(`${name}: min must be a non-negative safe integer`)
  }
  if (!(max === Number.POSITIVE_INFINITY || (Number.isSafeInteger(max) && max >= min))) {
    throw new RangeError(`${name}: max must be a safe integer >= min`)
  }
  return { min, max }
}

export const many: {
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<Array<A>>
  (opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<Array<A>>
} = F.dual(
  (args) => isGrammar(args[0]),
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<Array<A>> =>
    make({ _tag: "Many", inner, ...bounds("many", opts) }),
)

export const sepBy = <A>(
  inner: Grammar<A>,
  sep: Silent | string,
  opts?: RepeatOptions,
): Grammar<Array<A>> => make({ _tag: "SepBy", inner, sep: toSilent(sep), ...bounds("sepBy", opts) })

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  readonly is?: (u: unknown) => boolean
  readonly name?: string
}

export const transform: {
  <A, B>(f: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B>
} = F.dual(
  2,
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B> =>
    make({
      _tag: "Transform",
      inner,
      decode: f.decode,
      encode: f.encode,
      is: f.is,
      name: f.name,
    }),
)

export interface DecodeToOptions<A, T> {
  readonly decode: (a: A) => T
  readonly encode: (b: T) => A
  readonly name?: string
}

export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(f: DecodeToOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> => {
    let is: ((u: unknown) => boolean) | undefined
    return transform(inner, { ...f, is: (u) => (is ??= Schema.is(schema))(u) })
  }

export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(
  2,
  <const V>(inner: Silent, value: V): Grammar<V> => make({ _tag: "Const", inner, value }),
)

export const flag = (s: Silent | string): Grammar<boolean> =>
  choice(as(toSilent(s), true), as(empty, false))

export const skip: {
  <A>(printAs: A): (inner: Grammar<A>) => Silent
  <A>(inner: Grammar<A>, printAs: A): Silent
} = F.dual(
  2,
  <A>(inner: Grammar<A>, printAs: A): Silent =>
    silent({ _tag: "Skip", inner, printAs, show: true }),
)

export const label: {
  (name: string): <A>(inner: Grammar<A>) => Grammar<A>
  <A>(inner: Grammar<A>, name: string): Grammar<A>
} = F.dual(
  2,
  <A>(inner: Grammar<A>, name: string): Grammar<A> => make({ _tag: "Label", inner, name }),
)

export const suspend = <A>(thunk: () => Grammar<A>, name?: string): Grammar<A> =>
  make({ _tag: "Suspend", thunk, name })

const hiddenWhitespace = (printAs: string): Silent =>
  silent({ _tag: "Skip", inner: regex(/\s*/, "whitespace"), printAs, show: false })

export const whitespace: Silent = hiddenWhitespace("")

export const lexeme: {
  (inner: Silent): Silent
  <A>(inner: Grammar<A>): Grammar<A>
} = (inner: Grammar<any>): any => suffix(inner, hiddenWhitespace(" "))

export const symbol = (s: string): Silent => lexeme(literal(s))

export const integer: Grammar<number> = regex(/-?\d+/, "integer").pipe(
  transform({ decode: Number, encode: String, is: Number.isSafeInteger, name: "integer" }),
)
