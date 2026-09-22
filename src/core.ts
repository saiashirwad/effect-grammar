import { Pipeable, Predicate, Result, type Types, Utils } from "effect"

import type { ReturnPattern } from "./pattern.ts"

const GrammarTypeId: unique symbol = Symbol.for("effect-grammar/Grammar")
const NodeTypeId: unique symbol = Symbol("effect-grammar/Node")
const RefTypeId: unique symbol = Symbol("effect-grammar/Ref")

export type Value = {} | null | undefined

export interface AnyGrammar extends Pipeable.Pipeable {
  readonly [NodeTypeId]: Node
}

export interface Grammar<in out A> extends AnyGrammar {
  readonly [GrammarTypeId]: Types.Invariant<A>
  [Symbol.iterator](): Iterator<Grammar<A>, Yielded<A>, Yielded<A>>
}

export type Type<G> = G extends Grammar<infer A> ? A : never

export type Yielded<A> = [A] extends [void] ? void : Ref<A>

export abstract class Ref<out A> {
  // A protected brand is omitted by object-spread inference, so a copy is not a Ref.
  declare protected readonly [RefTypeId]: Types.Covariant<A>
}

export type Denote<T> =
  T extends Ref<infer A>
    ? A
    : T extends ReadonlyArray<unknown>
      ? { -readonly [K in keyof T]: Denote<T[K]> }
      : T extends object
        ? { -readonly [K in keyof T]: Denote<T[K]> }
        : T

class GrammarImpl<A> implements Grammar<A> {
  declare readonly [GrammarTypeId]: Types.Invariant<A>
  readonly [NodeTypeId]: Node

  constructor(node: Node) {
    this[NodeTypeId] = node
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }

  [Symbol.iterator]() {
    return new Utils.SingleShotGen<Grammar<A>, Yielded<A>>(this)
  }
}

Object.defineProperty(GrammarImpl.prototype, GrammarTypeId, { value: GrammarTypeId })

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)

export const nodeOf = (grammar: AnyGrammar): Node => grammar[NodeTypeId]

export const isGrammar = <T>(value: T): value is T & AnyGrammar => Predicate.hasProperty(value, GrammarTypeId)

export interface ScopeId {
  readonly _tag: "ScopeId"
}

export interface RefExpr {
  readonly _tag: "Ref"
  readonly scope: ScopeId
  readonly slot: number
}

export type Expr =
  | RefExpr
  | { readonly _tag: "Prop"; readonly object: Expr; readonly key: PropertyKey }
  | { readonly _tag: "Const"; readonly value: number }

export const isCount = (value: Value): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0

export type MatchKey = string | number | boolean

export interface Case {
  readonly key: MatchKey
  readonly grammar: AnyGrammar
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Regex"; readonly source: string; readonly flags: string }
  | { readonly _tag: "Take"; readonly count: Expr }
  | {
      readonly _tag: "Gen"
      readonly scope: ScopeId
      readonly steps: ReadonlyArray<AnyGrammar>
      readonly result: ReturnPattern
    }
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<AnyGrammar>; readonly print: "first" | "roundTrip" }
  | { readonly _tag: "Dispatch"; readonly tag: string; readonly cases: ReadonlyArray<Case> }
  | { readonly _tag: "Match"; readonly scrutinee: Expr; readonly cases: ReadonlyArray<Case> }
  | { readonly _tag: "Optional"; readonly inner: AnyGrammar }
  | {
      readonly _tag: "Repeat"
      readonly inner: AnyGrammar
      readonly sep: Grammar<void>
      readonly min: Expr
      readonly max: Expr | undefined
    }
  | {
      readonly _tag: "Transform"
      readonly inner: AnyGrammar
      readonly decode: (a: any) => Result.Result<Value, string>
      readonly encode: (b: any) => Result.Result<Value, string>
    }
  | { readonly _tag: "Skip"; readonly inner: AnyGrammar; readonly printAs: Value; readonly hidden: boolean }
  | { readonly _tag: "Label"; readonly inner: AnyGrammar; readonly name: string }
  | {
      readonly _tag: "Suspend"
      readonly thunk: () => AnyGrammar
      readonly name?: string | undefined
      resolved?: AnyGrammar | undefined
      resolving?: true | undefined
    }

export const nonByte = /[^\0-\xff]/

export const toBytes = (binary: string): Uint8Array => Uint8Array.from(binary, (char) => char.charCodeAt(0))

export const toText = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return binary
}

export const resolve = (node: Extract<Node, { _tag: "Suspend" }>): AnyGrammar => {
  if (node.resolved !== undefined) return node.resolved
  const where = `suspend${node.name === undefined ? "" : ` ${JSON.stringify(node.name)}`}`
  if (node.resolving) throw new Error(`${where}: thunk resolved itself while it was being evaluated`)
  node.resolving = true
  try {
    const target = node.thunk()
    if (!isGrammar(target)) throw new TypeError(`${where}: thunk must return a grammar`)
    node.resolved = target
    return target
  } finally {
    delete node.resolving
  }
}
