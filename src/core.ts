import { Pipeable, type Types, Utils } from "effect"

export type Value = {} | null | undefined

export interface Bounds {
  readonly min: number
  readonly max: number
}

export interface RefExpr {
  readonly _tag: "Ref"
  readonly id: number
}

export type Expr = RefExpr | { readonly _tag: "Prop"; readonly object: Expr; readonly key: string }

export type Pattern =
  | RefExpr
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
  | { readonly _tag: "Regex"; readonly re: RegExp; readonly whole: RegExp; readonly name: string }
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
  | { readonly _tag: "Match"; readonly scrutinee: Expr; readonly cases: ReadonlyArray<Case> }
  | {
      readonly _tag: "Dependent"
      readonly deps: ReadonlyArray<Expr>
      readonly select: (values: ReadonlyArray<any>) => Grammar<any> | undefined
      readonly recover: ((value: any) => ReadonlyArray<Value> | undefined) | undefined
      readonly show: (deps: ReadonlyArray<string>, render: (g: Grammar<any>) => string) => string
    }

export type Bound<A> = [A] extends [void] ? void : Ref<A>

export interface GrammarIterator<A> {
  next(...args: ReadonlyArray<any>): IteratorResult<Grammar<A>, Bound<A>>
}

export interface Grammar<out A> extends Pipeable.Pipeable {
  readonly _A: Types.Covariant<A>
  readonly node: Node
  [Symbol.iterator](): GrammarIterator<A>
}

export const SilentTypeId: unique symbol = Symbol.for("effect-grammar/Silent")

export interface Silent extends Grammar<void> {
  readonly [SilentTypeId]: true
}

export const RefTypeId: unique symbol = Symbol.for("effect-grammar/Ref")

export interface RefBase<out A> {
  readonly [RefTypeId]: Types.Covariant<A>
}

type RefProps<A> = [A] extends [ReadonlyArray<Value>]
  ? { readonly length: Ref<number> }
  : [A] extends [object]
    ? { readonly [K in keyof A & string]-?: Ref<A[K]> }
    : {}

export type Ref<A> = RefBase<A> & RefProps<A>

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
