import { Equal, Function as F, Schema } from "effect"

import {
  type Bounds,
  type Field,
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
import { preview } from "./errors.ts"

export { field } from "./core.ts"

export const literal = (value: string): Silent => silent({ _tag: "Literal", value })

export const empty: Silent = literal("")

/** The regex is made sticky so the parser can match at a position without slicing. */
export const regex = (re: RegExp, name: string): Grammar<string> => {
  const flags = re.flags.replace(/[gy]/g, "")
  return make({
    _tag: "Regex",
    re: new RegExp(re.source, `${flags}y`),
    whole: new RegExp(`^(?:${re.source})$`, flags),
    name,
  })
}

const toSilent = (s: Silent | string): Silent => (isGrammar(s) ? s : literal(s))

/** Silent when every part is silent, so the result can itself be `yield*`-ed. */
const silentIf = (cond: boolean, node: Node): any => (cond ? silent(node) : make(node))

export function seq(...parts: ReadonlyArray<Silent>): Silent
export function seq<const Parts extends ReadonlyArray<Silent | Field<string, any>>>(
  ...parts: Parts
): Grammar<Fields<Parts[number]>>
export function seq(...parts: ReadonlyArray<Part>) {
  const node = { _tag: "Seq", parts } satisfies Extract<Node, { _tag: "Seq" }>
  return silentIf(!parts.some(isField), node)
}

export const gen = <Y extends Silent | Field<string, any>, R extends Fields<Y> | void = void>(
  run: () => Generator<Y, R, any>,
): Grammar<[R] extends [void] ? Fields<Y> : R> => make({ _tag: "Gen", run })

export function wrap(open: Silent | string, inner: Silent, close: Silent | string): Silent
export function wrap<A>(
  open: Silent | string,
  inner: Grammar<A>,
  close: Silent | string,
): Grammar<A>
export function wrap(open: Silent | string, inner: Grammar<any>, close: Silent | string) {
  const node = {
    _tag: "Wrap",
    open: toSilent(open),
    inner,
    close: toSilent(close),
  } satisfies Extract<Node, { _tag: "Wrap" }>
  return silentIf(isSilent(inner), node)
}

export function prefix(open: Silent | string, inner: Silent): Silent
export function prefix<A>(open: Silent | string, inner: Grammar<A>): Grammar<A>
export function prefix(open: Silent | string, inner: Grammar<any>) {
  return wrap(open, inner, empty)
}

export function suffix(inner: Silent, close: Silent | string): Silent
export function suffix<A>(inner: Grammar<A>, close: Silent | string): Grammar<A>
export function suffix(inner: Grammar<any>, close: Silent | string) {
  return wrap(empty, inner, close)
}

export const choice = <const Gs extends readonly [Grammar<any>, ...Array<Grammar<any>>]>(
  ...options: Gs
): Grammar<Type<Gs[number]>> => make({ _tag: "Choice", options })

export function optional(inner: Silent): Silent
export function optional<A>(inner: Grammar<A>): Grammar<A | undefined>
export function optional(inner: Grammar<any>) {
  const node = { _tag: "Optional", inner } satisfies Extract<Node, { _tag: "Optional" }>
  return silentIf(isSilent(inner), node)
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
  if (max !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(max) && max >= min)) {
    throw new RangeError(`${name}: max must be a safe integer >= min`)
  }
  return { min, max }
}

/** For `dual` with optional trailing options: data-first when the first argument is a grammar. */
const dataFirst = (args: IArguments) => isGrammar(args[0])

export const many: {
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(
  dataFirst,
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<ReadonlyArray<A>> =>
    make({ _tag: "Many", inner, sep: empty, ...bounds("many", opts) }),
)

export const sepBy: {
  <A>(inner: Grammar<A>, sep: Silent | string, opts?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (sep: Silent | string, opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(
  dataFirst,
  <A>(inner: Grammar<A>, sep: Silent | string, opts?: RepeatOptions): Grammar<ReadonlyArray<A>> =>
    make({ _tag: "Many", inner, sep: toSilent(sep), ...bounds("sepBy", opts) }),
)

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  /** Guards `decode`'s output on parse and the input on print. */
  readonly is?: (value: B) => boolean
  readonly name?: string
}

export const transform: {
  <A, B>(f: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B>
} = F.dual(
  2,
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B> =>
    make({ _tag: "Transform", inner, ...f }),
)

export interface DecodeToOptions<A, T> extends Omit<TransformOptions<A, T>, "is"> {
  /**
   * Defaults to `Schema.is(schema)`, which checks the whole value. Inside a recursive
   * grammar every nested node would then re-check its subtree, so pass a cheap
   * discriminator there, e.g. `is: (v) => v.kind === "list"`.
   */
  readonly is?: ((value: T) => boolean) | undefined
}

/**
 * Curried on purpose: with the schema and options in one call TS widens literal
 * types in `decode`'s return. `Schema.is` is built lazily so recursive schemas work.
 */
export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(f: DecodeToOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> => {
    let is: ((value: T) => boolean) | undefined
    return transform(inner, { ...f, is: f.is ?? ((value) => (is ??= Schema.is(schema))(value)) })
  }

export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(
  2,
  <const V>(inner: Silent, value: V): Grammar<V> =>
    transform(inner, {
      decode: () => value,
      encode: () => undefined,
      is: (u) => Equal.equals(u, value),
      name: preview(value),
    }),
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

export function lexeme(inner: Silent): Silent
export function lexeme<A>(inner: Grammar<A>): Grammar<A>
export function lexeme(inner: Grammar<any>) {
  return suffix(inner, hiddenWhitespace(" "))
}

export const symbol = (s: string): Silent => lexeme(literal(s))

export const integer: Grammar<number> = regex(/-?\d+/, "integer").pipe(
  transform({ decode: Number, encode: String, is: Number.isSafeInteger, name: "integer" }),
)
