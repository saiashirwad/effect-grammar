import { Pipeable, type Types, Utils } from "effect"

export type Part = Field<string, any> | Grammar<any>

export interface Bounds {
  readonly min: number
  readonly max: number
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | {
      readonly _tag: "Regex"
      /** Sticky, for matching at a position. */
      readonly re: RegExp
      /** Anchored, for checking a whole value on print. */
      readonly whole: RegExp
      readonly name: string
    }
  | { readonly _tag: "Seq"; readonly parts: ReadonlyArray<Part> }
  | { readonly _tag: "Gen"; readonly run: () => Generator<Part, any, any> }
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

export interface Grammar<out A> extends Pipeable.Pipeable {
  /** Phantom marker for the value type. A function so a union of grammars infers a union of values. */
  readonly _A: Types.Covariant<A>
  readonly node: Node
}

/** A grammar with no value. Only these (and fields) can be `yield*`-ed inside `gen`. */
export interface Silent extends Grammar<void> {
  [Symbol.iterator](): Iterator<Silent, void>
}

export interface Field<K extends string, A> {
  readonly name: K
  readonly grammar: Grammar<A>
  [Symbol.iterator](): Iterator<Field<K, A>, A>
}

class GrammarImpl<A> implements Grammar<A> {
  declare readonly _A: Types.Covariant<A>
  readonly node: Node
  constructor(node: Node) {
    this.node = node
  }
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

class SilentImpl extends GrammarImpl<void> implements Silent {
  [Symbol.iterator]() {
    return new Utils.SingleShotGen<Silent, void>(this)
  }
}

class FieldImpl<K extends string, A> implements Field<K, A> {
  readonly name: K
  readonly grammar: Grammar<A>
  constructor(name: K, grammar: Grammar<A>) {
    this.name = name
    this.grammar = grammar
  }
  [Symbol.iterator]() {
    return new Utils.SingleShotGen<Field<K, A>, A>(this)
  }
}

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)
export const silent = (node: Node): Silent => new SilentImpl(node)
/** Typed via `G` rather than `A` so a conditional `a ? g1 : g2` infers the union of both values. */
export const field = <const K extends string, G extends Grammar<any>>(
  name: K,
  grammar: G,
): Field<K, Type<G>> => new FieldImpl(name, grammar)

export const isGrammar = (value: any): value is Grammar<any> => value instanceof GrammarImpl
export const isSilent = (g: Grammar<any>): g is Silent => g instanceof SilentImpl
export const isField = (p: Part): p is Field<string, any> => p instanceof FieldImpl

export const resolve = (n: Extract<Node, { _tag: "Suspend" }>): Grammar<any> =>
  (n.resolved ??= n.thunk())

export type Type<G> = G extends Grammar<infer A> ? A : never

type Names<Y> = Y extends Field<infer K, any> ? K : never

export type Fields<Y> = { [K in Names<Y>]: Y extends Field<K, infer A> ? A : never }
