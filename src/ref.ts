import { Predicate } from "effect"

import { type Expr, Ref, type ScopeId, type Value } from "./core.ts"

export interface Scope {
  readonly id: ScopeId
  open: boolean
}

interface RefEntry {
  readonly expr: Expr
  readonly scope: Scope
}

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, " +
      "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

class RefImpl<A> extends Ref<A> {
  [Symbol.toPrimitive]() {
    return escaped()
  }

  override valueOf() {
    return escaped()
  }

  override toString() {
    return escaped()
  }
}

const refs = new WeakMap<object, RefEntry>()

export const entryOf = (ref: Ref<Value>): RefEntry => {
  const entry = refs.get(ref)
  if (entry === undefined) throw new TypeError("expected a Grammar.Ref")
  return entry
}

// Only enumeration is intercepted: a spread must not silently turn a ref into {}.
const refHandler: ProxyHandler<object> = {
  ownKeys() {
    throw new TypeError(
      "a Grammar.Ref cannot be spread or enumerated; return the whole ref and use transform to reshape its value",
    )
  },
}

export const refFor = <A>(expr: Expr, scope: Scope): Ref<A> => {
  const ref = new Proxy<RefImpl<A>>(new RefImpl<A>(), refHandler)
  refs.set(ref, { expr, scope })
  return ref
}

const entryInScope = (ref: Ref<Value>, where: string): RefEntry => {
  const entry = entryOf(ref)
  if (!entry.scope.open) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return entry
}

export const assertInScope = (ref: Ref<Value>, where: string): Expr => entryInScope(ref, where).expr

export const get = <A, K extends keyof A>(ref: Ref<A>, key: K): Ref<A[K]> => {
  const { expr, scope } = entryInScope(ref, "get")
  return refFor({ _tag: "Prop", object: expr, key }, scope)
}

export const isRef = (value: Value): value is Ref<Value> => Predicate.isObject(value) && refs.has(value)
