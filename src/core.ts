import { Pipeable, Predicate, type Types, Utils } from "effect"

/** Anything a grammar can parse or print. The same as `unknown`, spelled so it narrows. */
export type Value = {} | null | undefined

export interface Bounds {
  readonly min: number
  readonly max: number
}

/** A symbolic value inside `gen`: a binding, or a property of one. */
export type Expr =
  | { readonly _tag: "Ref"; readonly id: number }
  | { readonly _tag: "Prop"; readonly object: Expr; readonly key: string }

/** The shape of a `gen` return: the invertible half of the grammar's value. */
export type Pattern =
  | { readonly _tag: "Ref"; readonly id: number }
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, Pattern]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<Pattern> }

export type Step =
  | { readonly _tag: "Silent"; readonly grammar: Silent }
  | { readonly _tag: "Bind"; readonly id: number; readonly grammar: Grammar<any> }

export interface Case {
  readonly key: string
  readonly grammar: Grammar<any>
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | {
      readonly _tag: "Regex"
      // Sticky, for matching at a position.
      readonly re: RegExp
      // Anchored, for checking a whole value on print.
      readonly whole: RegExp
      readonly name: string
    }
  | { readonly _tag: "Gen"; readonly steps: ReadonlyArray<Step>; readonly result: Pattern }
  | {
      readonly _tag: "Wrap"
      readonly open: Silent
      readonly inner: Grammar<any>
      readonly close: Silent
    }
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<Grammar<any>> }
  | ({ readonly _tag: "Many"; readonly inner: Grammar<any>; readonly sep: Silent } & Bounds)
  | { readonly _tag: "Optional"; readonly inner: Grammar<any> }
  | {
      readonly _tag: "Transform"
      readonly inner: Grammar<any>
      readonly decode: (a: any) => any
      readonly encode: (b: any) => any
      readonly is?: ((value: any) => boolean) | undefined
      readonly name?: string | undefined
    }
  | {
      readonly _tag: "Skip"
      readonly inner: Grammar<any>
      readonly printAs: any
      readonly show: boolean
    }
  | { readonly _tag: "Label"; readonly inner: Grammar<any>; readonly name: string }
  | {
      readonly _tag: "Suspend"
      readonly thunk: () => Grammar<any>
      readonly name?: string | undefined
      resolved?: Grammar<any> | undefined
    }
  // The grammar chosen by the value of an earlier binding.
  | { readonly _tag: "Match"; readonly scrutinee: Expr; readonly cases: ReadonlyArray<Case> }
  | {
      readonly _tag: "Dependent"
      readonly deps: ReadonlyArray<Expr>
      readonly select: (values: ReadonlyArray<any>) => Grammar<any> | undefined
      // On print, the dependencies' values from this grammar's own value.
      readonly recover: ((value: any) => ReadonlyArray<Value> | undefined) | undefined
      readonly show: (deps: ReadonlyArray<string>, render: (g: Grammar<any>) => string) => string
    }

/** What `yield*` hands back inside `gen`: nothing for a silent grammar, a `Ref` otherwise. */
export type Bound<A> = [A] extends [void] ? void : Ref<A>

// Only `next`, so the return type stays covariant: `Iterator` puts it in a parameter of `return`.
export interface GrammarIterator<A> {
  next(...args: ReadonlyArray<any>): IteratorResult<Grammar<A>, Bound<A>>
}

export interface Grammar<out A> extends Pipeable.Pipeable {
  readonly _A: Types.Covariant<A>
  readonly node: Node
  [Symbol.iterator](): GrammarIterator<A>
}

export const SilentTypeId: unique symbol = Symbol.for("effect-grammar/Silent")
export type SilentTypeId = typeof SilentTypeId

// A grammar with no value. It prints from nothing, so `gen` need not bind it.
export interface Silent extends Grammar<void> {
  readonly [SilentTypeId]: true
}

export const RefTypeId: unique symbol = Symbol.for("effect-grammar/Ref")
export type RefTypeId = typeof RefTypeId

export interface RefBase<out A> {
  readonly [RefTypeId]: Types.Covariant<A>
}

type RefProps<A> = [A] extends [ReadonlyArray<Value>]
  ? { readonly length: Ref<number> }
  : [A] extends [object]
    ? { readonly [K in keyof A & string]-?: Ref<A[K]> }
    : {}

/**
 * A symbolic reference to a value that exists only while parsing or printing.
 * Inside `gen`, `yield*` on a value grammar returns one. Reading a property
 * returns a `Ref` to that property. It has no value at construction time, so
 * JavaScript operators on it are an error; route decisions through `match`.
 */
export type Ref<A> = RefBase<A> & RefProps<A>

/** The value type of a `gen` return: every `Ref<A>` becomes `A`. */
export type Denote<T> =
  T extends RefBase<infer A>
    ? A
    : T extends ReadonlyArray<Value>
      ? { -readonly [K in keyof T]: Denote<T[K]> }
      : T extends object
        ? { -readonly [K in keyof T]: Denote<T[K]> }
        : T

export type Type<G> = G extends Grammar<infer A> ? A : never

class GrammarImpl<A> implements Grammar<A> {
  declare readonly _A: Types.Covariant<A>
  readonly node: Node
  constructor(node: Node) {
    this.node = node
  }
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen<Grammar<A>, Bound<A>>(this)
  }
}

class SilentImpl extends GrammarImpl<void> implements Silent {
  declare readonly [SilentTypeId]: true
}

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)
export const silent = (node: Node): Silent => new SilentImpl(node)

export const isGrammar = (value: Value): value is Grammar<any> => value instanceof GrammarImpl
export const isSilent = (g: Grammar<any>): g is Silent => g instanceof SilentImpl

export const resolve = (n: Extract<Node, { _tag: "Suspend" }>): Grammar<any> =>
  (n.resolved ??= n.thunk())

class RefImpl {
  declare readonly [RefTypeId]: Types.Covariant<any>
}

// Kept beside the proxy, not on it, so every property name is free to be a projection.
const exprs = new WeakMap<RefBase<any>, Expr>()

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, " +
      "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

const refHandler: ProxyHandler<RefImpl> = {
  get(_target, key, receiver) {
    if (key === Symbol.toPrimitive || key === "valueOf" || key === "toString") return escaped
    if (key === "then" || key === "toJSON" || !Predicate.isString(key)) return undefined
    return refFor({ _tag: "Prop", object: exprOf(receiver), key })
  },
}

export const refFor = (expr: Expr): RefBase<any> => {
  const ref: RefBase<any> = new Proxy(new RefImpl(), refHandler)
  exprs.set(ref, expr)
  return ref
}

export const isRef = (value: Value): value is RefBase<any> => value instanceof RefImpl

export const exprOf = (ref: RefBase<any>): Expr => {
  const expr = exprs.get(ref)
  if (expr === undefined) throw new TypeError("expected a Grammar.Ref")
  return expr
}

export const rootId = (expr: Expr): number => (expr._tag === "Ref" ? expr.id : rootId(expr.object))

let nextId = 0
export const freshId = (): number => nextId++

// The bindings of every `gen` whose generator is still running, innermost last.
const scopes: Array<Set<number>> = []

export const enterScope = (): Set<number> => {
  const scope = new Set<number>()
  scopes.push(scope)
  return scope
}

export const exitScope = (): void => {
  scopes.pop()
}

/** A ref is usable only while the `gen` that bound it (or one nested in it) is being built. */
export const assertInScope = (ref: RefBase<any>, where: string): Expr => {
  const expr = exprOf(ref)
  const id = rootId(expr)
  if (!scopes.some((scope) => scope.has(id))) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return expr
}
