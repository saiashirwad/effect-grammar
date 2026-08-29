import { Equal, Function as F, Predicate, Schema } from "effect"

import {
  type Bounds,
  type Grammar,
  isGrammar,
  isSilent,
  make,
  type Node,
  type Ref,
  type RefBase,
  type Silent,
  silent,
  type Type,
  type Value,
} from "./core.ts"
import { preview } from "./errors.ts"
import { assertInScope } from "./gen.ts"

export { gen, type GenGrammar, seq } from "./gen.ts"

export const literal = (value: string) => silent({ _tag: "Literal", value })

export const empty = literal("")

export const regex = (re: RegExp, name: string): Grammar<string> => {
  const flags = re.flags.replace(/[gy]/g, "")
  return make({
    _tag: "Regex",
    re: new RegExp(re.source, `${flags}y`),
    whole: new RegExp(`^(?:${re.source})$`, flags),
    name,
  })
}

const _toSilent = (s: Silent | string) => (isGrammar(s) ? s : literal(s))

const _silentIf = (cond: boolean, node: Node): any => (cond ? silent(node) : make(node))

export function wrap(open: Silent | string, inner: Silent, close: Silent | string): Silent
export function wrap<A>(
  open: Silent | string,
  inner: Grammar<A>,
  close: Silent | string,
): Grammar<A>
export function wrap(open: Silent | string, inner: Grammar<any>, close: Silent | string) {
  return _silentIf(isSilent(inner), {
    _tag: "Wrap",
    open: _toSilent(open),
    inner,
    close: _toSilent(close),
  })
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
  return _silentIf(isSilent(inner), { _tag: "Optional", inner })
}

export interface RepeatOptions {
  readonly min?: number
  readonly max?: number
}

const isCount = (n: Value): n is number =>
  Predicate.isNumber(n) && Number.isSafeInteger(n) && n >= 0

const bounds = (name: string, opts: RepeatOptions | undefined): Bounds => {
  const min = opts?.min ?? 0
  const max = opts?.max ?? Number.POSITIVE_INFINITY
  if (!isCount(min)) throw new RangeError(`${name}: min must be a non-negative safe integer`)
  if (max !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(max) && max >= min)) {
    throw new RangeError(`${name}: max must be a safe integer >= min`)
  }
  return { min, max }
}

const _dataFirst = (args: IArguments) => isGrammar(args[0])

export const many: {
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(_dataFirst, <A>(inner: Grammar<A>, opts?: RepeatOptions) =>
  make({ _tag: "Many", inner, sep: empty, ...bounds("many", opts) }),
)

export const sepBy: {
  <A>(inner: Grammar<A>, sep: Silent | string, opts?: RepeatOptions): Grammar<ReadonlyArray<A>>
  (sep: Silent | string, opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(_dataFirst, <A>(inner: Grammar<A>, sep: Silent | string, opts?: RepeatOptions) =>
  make({ _tag: "Many", inner, sep: _toSilent(sep), ...bounds("sepBy", opts) }),
)

export type RefValues<Deps extends ReadonlyArray<RefBase<any>>> = {
  -readonly [K in keyof Deps]: Deps[K] extends RefBase<infer A> ? A : never
}

export interface DependentOptions<Deps extends ReadonlyArray<RefBase<any>>, A> {
  readonly recover?: (value: A) => RefValues<Deps> | undefined
  readonly show?: (deps: ReadonlyArray<string>, render: (g: Grammar<any>) => string) => string
}

const _dependent = <const Deps extends ReadonlyArray<RefBase<any>>, A>(
  where: string,
  deps: Deps,
  select: (...values: RefValues<Deps>) => Grammar<A> | undefined,
  options: DependentOptions<Deps, A> | undefined,
): Grammar<A> =>
  make({
    _tag: "Dependent",
    deps: deps.map((d) => assertInScope(d, where)),
    // SAFETY: the interpreters evaluate `deps` in order, so `values` has the shape RefValues<Deps>.
    select: (values) => select(...(values as RefValues<Deps>)),
    recover: options?.recover,
    show: options?.show ?? ((ds) => `${where}(${ds.join(", ")})`),
  })

export const dependent = <const Deps extends ReadonlyArray<RefBase<any>>, A>(
  deps: Deps,
  select: (...values: RefValues<Deps>) => Grammar<A> | undefined,
  options?: DependentOptions<Deps, A>,
) => _dependent("dependent", deps, select, options)

type Key = string | number | boolean

export const match = <K extends Key, const Cases extends Record<`${K}`, Grammar<any>>>(
  scrutinee: Ref<K>,
  cases: Cases,
): Grammar<Type<Cases[keyof Cases]>> =>
  make({
    _tag: "Match",
    scrutinee: assertInScope(scrutinee, "match"),
    cases: Object.entries<Grammar<any>>(cases).map(([key, grammar]) => ({ key, grammar })),
  })

const byCount = <A>(build: (count: number) => Grammar<A>) => {
  const cache = new Map<number, Grammar<A>>()
  return (n: number) => {
    if (!isCount(n)) return undefined
    let g = cache.get(n)
    if (g === undefined) cache.set(n, (g = build(n)))
    return g
  }
}

export const take = (count: Ref<number>) =>
  _dependent(
    "take",
    [count],
    byCount((c) => regex(new RegExp(`[\\s\\S]{${c}}`), `${c} chars`)),
    {
      recover: (s) => (Predicate.isString(s) ? [s.length] : undefined),
      show: ([n]) => `<char>{${n}}`,
    },
  )

export const repeat: {
  <A>(inner: Grammar<A>, count: Ref<number>): Grammar<ReadonlyArray<A>>
  (count: Ref<number>): <A>(inner: Grammar<A>) => Grammar<ReadonlyArray<A>>
} = F.dual(_dataFirst, <A>(inner: Grammar<A>, count: Ref<number>) =>
  _dependent(
    "repeat",
    [count],
    byCount((c) => many(inner, { min: c, max: c })),
    {
      recover: (xs) => (Array.isArray(xs) ? [xs.length] : undefined),
      show: ([n], render) => `(${render(inner)}){${n}}`,
    },
  ),
)

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  readonly is?: (value: B) => boolean
  readonly name?: string
}

export const transform: {
  <A, B>(f: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B>
} = F.dual(2, <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>) =>
  make({ _tag: "Transform", inner, ...f }),
)

export interface DecodeToOptions<A, T> extends Omit<TransformOptions<A, T>, "is"> {
  readonly is?: ((value: T) => boolean) | undefined
}

export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(f: DecodeToOptions<A, T>) =>
  (inner: Grammar<A>) => {
    let is: ((value: T) => boolean) | undefined
    return transform(inner, { ...f, is: f.is ?? ((value) => (is ??= Schema.is(schema))(value)) })
  }

export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(2, <const V>(inner: Silent, value: V) =>
  transform(inner, {
    decode: () => value,
    encode: () => undefined,
    is: (u) => Equal.equals(u, value),
    name: preview(value),
  }),
)

export const flag = (s: Silent | string) => choice(as(_toSilent(s), true), as(empty, false))

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

const hiddenWhitespace = (printAs: string) =>
  silent({ _tag: "Skip", inner: regex(/\s*/, "whitespace"), printAs, show: false })

export const whitespace = hiddenWhitespace("")

export function lexeme(inner: Silent): Silent
export function lexeme<A>(inner: Grammar<A>): Grammar<A>
export function lexeme(inner: Grammar<any>) {
  return suffix(inner, hiddenWhitespace(" "))
}

export const symbol = (s: string) => lexeme(literal(s))

export const integer = regex(/-?\d+/, "integer").pipe(
  transform({ decode: Number, encode: String, is: Number.isSafeInteger, name: "integer" }),
)
