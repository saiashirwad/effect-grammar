import { Pipeable } from "effect"

export type Part = Field<string, any> | Grammar<any>

export interface Bounds {
  readonly min: number
  readonly max: number
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Regex"; readonly re: RegExp; readonly name: string }
  | { readonly _tag: "Seq"; readonly parts: ReadonlyArray<Part> }
  | { readonly _tag: "Gen"; readonly run: () => Generator<Part, any, any> }
  | {
      readonly _tag: "Wrap"
      readonly open: Grammar<void>
      readonly inner: Grammar<any>
      readonly close: Grammar<void>
    }
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<Grammar<any>> }
  | ({ readonly _tag: "Many"; readonly inner: Grammar<any> } & Bounds)
  | ({ readonly _tag: "SepBy"; readonly inner: Grammar<any>; readonly sep: Grammar<void> } & Bounds)
  | { readonly _tag: "Optional"; readonly inner: Grammar<any> }
  | {
      readonly _tag: "Transform"
      readonly inner: Grammar<any>
      readonly decode: (a: any) => any
      readonly encode: (b: any) => any
      readonly is: ((u: unknown) => boolean) | undefined
      readonly name: string | undefined
    }
  | { readonly _tag: "Const"; readonly inner: Grammar<void>; readonly value: unknown }
  | {
      readonly _tag: "Skip"
      readonly inner: Grammar<any>
      readonly printAs: unknown
      readonly show: boolean
    }
  | { readonly _tag: "Label"; readonly inner: Grammar<any>; readonly name: string }
  | {
      readonly _tag: "Suspend"
      readonly thunk: () => Grammar<any>
      readonly name: string | undefined
      resolved?: Grammar<any>
    }

export interface GenIterator<Y, A> {
  next(...args: ReadonlyArray<any>): IteratorResult<Y, A>
  [Symbol.iterator](): GenIterator<Y, A>
}

export class SingleShot<Y, A> implements GenIterator<Y, A> {
  private called = false
  readonly self: Y
  constructor(self: Y) {
    this.self = self
  }
  next(a: A): IteratorResult<Y, A> {
    if (this.called) return { done: true, value: a }
    this.called = true
    return { done: false, value: this.self }
  }
  [Symbol.iterator](): GenIterator<Y, A> {
    return new SingleShot(this.self)
  }
}

declare const TypeId: unique symbol

export interface Grammar<out A> extends Pipeable.Pipeable {
  readonly [TypeId]: { readonly _A: () => A }
  readonly node: Node
}

export interface Silent extends Grammar<void> {
  [Symbol.iterator](): GenIterator<Silent, void>
}

export interface Field<K extends string, A> {
  readonly _tag: "Field"
  readonly name: K
  readonly grammar: Grammar<A>
  [Symbol.iterator](): GenIterator<Field<K, A>, A>
}

class GrammarImpl<A> implements Grammar<A> {
  declare readonly [TypeId]: { readonly _A: () => A }
  readonly node: Node
  constructor(node: Node) {
    this.node = node
  }
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

class SilentImpl extends GrammarImpl<void> implements Silent {
  [Symbol.iterator](): GenIterator<Silent, void> {
    return new SingleShot<Silent, void>(this)
  }
}

export class FieldImpl<K extends string, A> implements Field<K, A> {
  readonly _tag = "Field" as const
  readonly name: K
  readonly grammar: Grammar<A>
  constructor(name: K, grammar: Grammar<A>) {
    this.name = name
    this.grammar = grammar
  }
  [Symbol.iterator](): GenIterator<Field<K, A>, A> {
    return new SingleShot<Field<K, A>, A>(this)
  }
}

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)
export const silent = (node: Node): Silent => new SilentImpl(node)
export const isGrammar = (u: unknown): u is Grammar<any> => u instanceof GrammarImpl
export const isSilent = (g: Grammar<any>): g is Silent => g instanceof SilentImpl
export const isField = (p: Part): p is Field<string, any> => p instanceof FieldImpl

export const resolve = (n: Extract<Node, { _tag: "Suspend" }>): Grammar<any> =>
  (n.resolved ??= n.thunk())

export type Type<G> = G extends Grammar<infer A> ? A : never

type Names<Y> = Y extends Field<infer K, any> ? K : never

export type Fields<Y> = { [K in Names<Y>]: Y extends Field<K, infer A> ? A : never }
