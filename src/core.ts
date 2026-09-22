import { Pipeable, Predicate, Result, type Types, Utils } from "effect"

const GrammarTypeId: unique symbol = Symbol.for("effect-grammar/Grammar")
const SilentTypeId: unique symbol = Symbol("effect-grammar/Silent")
const NodeTypeId: unique symbol = Symbol("effect-grammar/Node")
export const RefTypeId: unique symbol = Symbol("effect-grammar/Ref")

// Every JavaScript value; `{}` is TypeScript's non-nullish top type.
export type Value = {} | null | undefined

// A grammar whose output type is not tracked.
export interface AnyGrammar extends Pipeable.Pipeable {
  readonly [NodeTypeId]: Node
}

export interface Grammar<in out A> extends AnyGrammar {
  readonly [GrammarTypeId]: Types.Invariant<A>
  [Symbol.iterator](): Iterator<Grammar<A>, Yielded<A>, Yielded<A>>
}

// A grammar that binds nothing when yielded inside `gen`.
export interface Silent extends Grammar<void> {
  readonly [SilentTypeId]: true
}

export type Type<G> = G extends Grammar<infer A> ? A : never

// What `yield*` gives back inside `gen`: a ref to the parsed value.
export type Yielded<A> = [A] extends [void] ? void : Ref<A>

export interface RefBase<out A> {
  readonly [RefTypeId]: Types.Covariant<A>
}

type RefProps<A> = [A] extends [ReadonlyArray<unknown>]
  ? { readonly length: Ref<number> }
  : [A] extends [object]
    ? { readonly [K in keyof A & string]-?: Ref<A[K]> }
    : {}

export type Ref<A> = RefBase<A> & RefProps<A>

// The value a `gen` returns, with every ref replaced by what it refers to.
export type Denote<T> =
  T extends RefBase<infer A>
    ? A
    : T extends ReadonlyArray<unknown>
      ? { -readonly [K in keyof T]: Denote<T[K]> }
      : T extends object
        ? { -readonly [K in keyof T]: Denote<T[K]> }
        : T

class GrammarImpl<A> implements Grammar<A> {
  declare readonly [GrammarTypeId]: Types.Invariant<A>
  declare readonly [SilentTypeId]: true
  readonly [NodeTypeId]: Node
  readonly silent: boolean

  constructor(node: Node, silent: boolean) {
    this[NodeTypeId] = node
    this.silent = silent
  }

  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }

  [Symbol.iterator]() {
    return new Utils.SingleShotGen<Grammar<A>, Yielded<A>>(this)
  }
}

Object.defineProperty(GrammarImpl.prototype, GrammarTypeId, { value: GrammarTypeId })

export const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node, false)

export const silent = (node: Node): Silent => new GrammarImpl<void>(node, true)

export const nodeOf = (grammar: AnyGrammar): Node => grammar[NodeTypeId]

export const isGrammar = <T>(value: T): value is T & AnyGrammar => Predicate.hasProperty(value, GrammarTypeId)

export const isSilent = (grammar: AnyGrammar): grammar is Silent =>
  // SAFETY: every grammar is a GrammarImpl; the interfaces only hide it.
  (grammar as GrammarImpl<Value>).silent

export interface ScopeId {
  readonly _tag: "ScopeId"
}

export interface RefExpr {
  readonly _tag: "Ref"
  readonly scope: ScopeId
  readonly slot: number
}

// Reads a value bound earlier in an enclosing `gen`.
export type Expr =
  | RefExpr
  | { readonly _tag: "Prop"; readonly object: Expr; readonly key: PropertyKey }
  | { readonly _tag: "Const"; readonly value: number }

export const isCount = (value: Value): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0

// The shape a `gen` returns, built from bound values when parsing and taken apart when printing.
export type Pattern =
  | RefExpr
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, Pattern]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<Pattern> }

export type MatchKey = string | number | boolean

export interface Case {
  readonly key: MatchKey
  readonly grammar: AnyGrammar
}

export type Step =
  | { readonly _tag: "Silent"; readonly grammar: Silent }
  | { readonly _tag: "Bind"; readonly slot: number; readonly grammar: AnyGrammar }

// Laws claimed by a transform.
//
// - `unchecked`: no law claimed (`transform`, `transformOrFail`).
// - `partial`: both directions may fail, and agree where they succeed (`partialIso`).
// - `claimed-iso`: the author claims the directions are inverse (`iso`, `decodeTo`, `as`).
export type Fidelity = "unchecked" | "partial" | "claimed-iso"

export interface GrammarIssue {
  readonly message: string
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string; readonly name?: string | undefined }
  | { readonly _tag: "Regex"; readonly source: string; readonly flags: string; readonly name: string }
  | {
      readonly _tag: "Take"
      readonly count: Expr
      readonly unit: "char" | "byte"
      readonly name?: string | undefined
    }
  | {
      readonly _tag: "Gen"
      readonly scope: ScopeId
      readonly slotCount: number
      readonly steps: ReadonlyArray<Step>
      readonly result: Pattern
    }
  | { readonly _tag: "Wrap"; readonly open: Silent; readonly inner: AnyGrammar; readonly close: Silent }
  | {
      readonly _tag: "Merge"
      readonly parts: ReadonlyArray<{ readonly grammar: AnyGrammar; readonly keys: ReadonlyArray<string> }>
    }
  // Parse with the first branch that matches. Print with the first branch that accepts the value,
  // or when `checked`, the first whose printed text parses back to the input value.
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<AnyGrammar>; readonly checked: boolean }
  // Parse like `Choice`; print with the case whose key equals `value[tag]`.
  | { readonly _tag: "Dispatch"; readonly tag: string; readonly cases: ReadonlyArray<Case> }
  // Parse and print with the case whose key equals the scrutinee's bound value.
  | { readonly _tag: "Match"; readonly scrutinee: Expr; readonly cases: ReadonlyArray<Case> }
  | { readonly _tag: "Optional"; readonly inner: AnyGrammar }
  | {
      readonly _tag: "Repeat"
      readonly inner: AnyGrammar
      readonly sep: Silent
      readonly min: Expr
      readonly max: Expr | undefined
    }
  | {
      readonly _tag: "Transform"
      readonly inner: AnyGrammar
      readonly decode: (a: any) => Result.Result<Value, GrammarIssue>
      readonly encode: (b: any) => Result.Result<Value, GrammarIssue>
      readonly is?: ((value: any) => boolean) | undefined
      readonly name?: string | undefined
      readonly fidelity: Fidelity
      // Fields known to be in the output, so `merge` can split a value between parts.
      readonly keys?: ReadonlyArray<string> | undefined
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

// Byte grammars parse and print a string whose code units are the bytes 0..255.
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
