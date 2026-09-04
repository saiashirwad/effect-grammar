import { Pipeable, Predicate, Result, type Types, Utils } from "effect"

const GrammarTypeId: unique symbol = Symbol.for("effect-grammar/Grammar")
const SilentTypeId: unique symbol = Symbol.for("effect-grammar/Silent")
const NodeTypeId: unique symbol = Symbol("effect-grammar/Node")
export const RefTypeId: unique symbol = Symbol.for("effect-grammar/Ref")

/** Every JavaScript value; `{}` is TypeScript's non-nullish top type. */
export type Value = {} | null | undefined

/**
 * Bridges an erased node callback with the runtime value produced for that
 * node. Node callbacks are stored as `never`-argument functions so the
 * public combinator types stay precise; this is the single choke point where
 * the runtime value is passed to them.
 */
export const unsafeToNever = (value: Value): never => {
  // SAFETY: erased Node callbacks accept the runtime value produced for that node.
  return value as never
}

export interface ScopeId {
  readonly _tag: "ScopeId"
}

export interface Bounds {
  readonly min: number
  readonly max: number
}

export interface RefExpr {
  readonly _tag: "Ref"
  readonly scope: ScopeId
  readonly slot: number
}

export type Expr =
  | RefExpr
  | { readonly _tag: "Prop"; readonly object: Expr; readonly key: PropertyKey }

export type Pattern =
  | RefExpr
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, Pattern]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<Pattern> }

export type MatchKey = string | number | boolean

/**
 * How much a `Transform` promises about its two directions.
 *
 * - `unchecked`: no law claimed (`transform`, `transformOrFail`).
 * - `partial`: both directions may fail, and agree where they succeed (`partialIso`).
 * - `claimed-iso`: the author claims the directions are inverse (`iso`, `decodeTo`, `as`).
 */
export type Fidelity = "unchecked" | "partial" | "claimed-iso"

export interface GrammarIssue {
  readonly message: string
}

export interface GrammarInternal extends Pipeable.Pipeable {
  readonly [NodeTypeId]: Node
}

export interface Case {
  readonly key: MatchKey
  readonly grammar: GrammarInternal
}

export type Step =
  | { readonly _tag: "Silent"; readonly grammar: Silent }
  | { readonly _tag: "Bind"; readonly slot: number; readonly grammar: GrammarInternal }

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Regex"; readonly re: RegExp; readonly name: string }
  | {
      readonly _tag: "Gen"
      readonly scope: ScopeId
      readonly slotCount: number
      readonly steps: ReadonlyArray<Step>
      readonly result: Pattern
    }
  | {
      readonly _tag: "Wrap"
      readonly open: Silent
      readonly inner: GrammarInternal
      readonly close: Silent
    }
  | {
      readonly _tag: "Choice"
      readonly options: ReadonlyArray<GrammarInternal>
      readonly on?: { readonly tag: string; readonly keys: ReadonlyArray<MatchKey> } | undefined
      /** Print with the first branch whose text parses back, not just the first that accepts. */
      readonly checked?: boolean | undefined
    }
  | ({ readonly _tag: "Many"; readonly inner: GrammarInternal; readonly sep: Silent } & Bounds)
  | { readonly _tag: "Optional"; readonly inner: GrammarInternal }
  | {
      readonly _tag: "Transform"
      readonly inner: GrammarInternal
      readonly decode: (a: never) => Result.Result<Value, GrammarIssue>
      readonly encode: (b: never) => Result.Result<Value, GrammarIssue>
      readonly is?: ((value: never) => boolean) | undefined
      readonly name?: string | undefined
      readonly fidelity: Fidelity
    }
  | {
      readonly _tag: "Skip"
      readonly inner: GrammarInternal
      readonly printAs: Value
      readonly show: boolean
    }
  | { readonly _tag: "Label"; readonly inner: GrammarInternal; readonly name: string }
  | {
      readonly _tag: "Suspend"
      readonly thunk: () => GrammarInternal
      readonly name?: string | undefined
      resolved?: GrammarInternal | undefined
    }
  | { readonly _tag: "Match"; readonly scrutinee: Expr; readonly cases: ReadonlyArray<Case> }
  | { readonly _tag: "Take"; readonly count: Expr }
  | { readonly _tag: "RepeatExact"; readonly count: Expr; readonly inner: GrammarInternal }

export type Bound<A> = [A] extends [void] ? void : Ref<A>

export interface GrammarIterator<A> {
  next(...args: ReadonlyArray<unknown>): IteratorResult<Grammar<A>, Bound<A>>
}

export interface Grammar<in out A> extends GrammarInternal {
  readonly [GrammarTypeId]: Types.Invariant<A>
  [Symbol.iterator](): GrammarIterator<A>
}

export interface Silent extends Grammar<void> {
  readonly [SilentTypeId]: true
}

export interface RefBase<out A> {
  readonly [RefTypeId]: Types.Covariant<A>
}

type RefProps<A> = [A] extends [ReadonlyArray<unknown>]
  ? { readonly length: Ref<number> }
  : [A] extends [object]
    ? { readonly [K in keyof A & string]-?: Ref<A[K]> }
    : {}

export type Ref<A> = RefBase<A> & RefProps<A>

export type Denote<T> =
  T extends RefBase<infer A>
    ? A
    : T extends ReadonlyArray<unknown>
      ? { -readonly [K in keyof T]: Denote<T[K]> }
      : T extends object
        ? { -readonly [K in keyof T]: Denote<T[K]> }
        : T

export type Type<G> = G extends Grammar<infer A> ? A : never

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
    return new Utils.SingleShotGen<Grammar<A>, Bound<A>>(this)
  }
}

Object.defineProperty(GrammarImpl.prototype, GrammarTypeId, { value: GrammarTypeId })

class SilentImpl extends GrammarImpl<void> implements Silent {
  declare readonly [SilentTypeId]: true
}

Object.defineProperty(SilentImpl.prototype, SilentTypeId, { value: true })

export const nodeOf = (grammar: GrammarInternal): Node => grammar[NodeTypeId]

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)

export const silent = (node: Node): Silent => new SilentImpl(node)

export const isGrammar = <T>(value: T): value is T & GrammarInternal =>
  Predicate.hasProperty(value, GrammarTypeId)

export const isSilent = (grammar: GrammarInternal): grammar is Silent =>
  Predicate.hasProperty(grammar, SilentTypeId)

export const resolve = (node: Extract<Node, { _tag: "Suspend" }>): GrammarInternal =>
  (node.resolved ??= node.thunk())

/** The grammars a node refers to directly. A `Suspend` yields its resolved target. */
export const children = (node: Node): ReadonlyArray<GrammarInternal> => {
  switch (node._tag) {
    case "Literal":
    case "Regex":
    case "Take":
      return []
    case "Gen":
      return node.steps.map((step) => step.grammar)
    case "Wrap":
      return [node.open, node.inner, node.close]
    case "Choice":
      return node.options
    case "Many":
      return [node.inner, node.sep]
    case "Optional":
    case "Transform":
    case "Label":
    case "Skip":
    case "RepeatExact":
      return [node.inner]
    case "Suspend":
      return [resolve(node)]
    case "Match":
      return node.cases.map((matchCase) => matchCase.grammar)
  }
}
