import { Predicate, type Types } from "effect"

import {
  type AnyGrammar,
  type Expr,
  isGrammar,
  type Pattern,
  type Ref,
  type RefBase,
  RefTypeId,
  type ScopeId,
  type Value,
} from "./core.ts"
import { describeStep } from "./render.ts"

// A gen's scope stays open only while its generator body runs.
export interface Scope {
  readonly id: ScopeId
  open: boolean
}

interface RefEntry {
  readonly expr: Expr
  readonly scope: Scope
}

class RefImpl<A> implements RefBase<A> {
  declare readonly [RefTypeId]: Types.Covariant<A>
}

Object.defineProperty(RefImpl.prototype, RefTypeId, { value: RefTypeId })

const refs = new WeakMap<object, RefEntry>()

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, " +
      "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

const entryOf = (ref: RefBase<Value>): RefEntry => {
  const entry = refs.get(ref)
  if (entry === undefined) throw new TypeError("expected a Grammar.Ref")
  return entry
}

// Property access on a ref yields a ref to that property. A few keys are reserved so
// refs behave when awaited, serialized, or coerced; use `get` to read those fields.
const refHandler: ProxyHandler<RefImpl<Value>> = {
  get(_target, key, receiver) {
    if (key === RefTypeId) return RefTypeId
    if (key === Symbol.toPrimitive) return escaped
    if (key === "then" || key === "toJSON") return undefined
    if (key === "valueOf" || key === "toString") return escaped
    if (!Predicate.isString(key)) return undefined
    const entry = entryOf(receiver)
    return refFor({ _tag: "Prop", object: entry.expr, key }, entry.scope)
  },
}

export const refFor = <A>(expr: Expr, scope: Scope): Ref<A> => {
  const ref = new Proxy(new RefImpl<A>(), refHandler)
  refs.set(ref, { expr, scope })
  // SAFETY: the proxy implements Ref<A>.
  return ref as Ref<A>
}

const entryInScope = (ref: RefBase<Value>, where: string): RefEntry => {
  const entry = entryOf(ref)
  if (!entry.scope.open) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return entry
}

export const assertInScope = (ref: RefBase<Value>, where: string): Expr => entryInScope(ref, where).expr

export const get = <A, K extends keyof A>(ref: Ref<A>, key: K): Ref<A[K]> => {
  const { expr, scope } = entryInScope(ref, "get")
  return refFor({ _tag: "Prop", object: expr, key }, scope)
}

const isRef = (value: Value): value is RefBase<Value> => Predicate.isObject(value) && refs.has(value)

const isPlainObject = <T extends object>(value: T): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Turn a gen's return value into the pattern that parsing builds and printing takes apart.
export const toPattern = (value: Value, active: WeakSet<object> = new WeakSet()): Pattern => {
  if (isRef(value)) {
    const { expr } = entryOf(value)
    if (expr._tag !== "Ref") {
      throw new Error(
        "gen: the return holds a property of a ref; printing cannot rebuild a value from one property, so return the whole ref",
      )
    }
    return expr
  }
  if (isGrammar(value)) {
    throw new Error("gen: the return holds a grammar; yield* it to bind its value, then return the ref")
  }
  if (
    value === null ||
    value === undefined ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isBigInt(value)
  ) {
    return { _tag: "Const", value }
  }
  if (!Predicate.isObjectOrArray(value)) {
    throw new TypeError("gen: the return pattern contains an unsupported constant")
  }
  if (active.has(value)) throw new TypeError("gen: the return pattern is cyclic")
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("gen: the return pattern contains symbol fields")
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value)
      if (names.length !== value.length + 1) {
        throw new TypeError("gen: return arrays must be dense tuples without extra fields")
      }
      const items: Array<Pattern> = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor?.enumerable !== true) {
          throw new TypeError("gen: return arrays must be dense tuples without extra fields")
        }
        items.push(toPattern(value[index], active))
      }
      return { _tag: "Array", items }
    }

    if (!isPlainObject(value)) {
      throw new TypeError("gen: return objects must have Object.prototype or a null prototype")
    }
    const fields: Array<readonly [string, Pattern]> = []
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true) {
        throw new TypeError("gen: return object fields must be enumerable")
      }
      fields.push([key, toPattern(value[key], active)])
    }
    return { _tag: "Object", fields }
  } finally {
    active.delete(value)
  }
}

// Printing reads a slot from wherever the pattern mentions it, so a ref may appear at most once.
export const assertRefsReturnedOnce = (scope: ScopeId, steps: ReadonlyArray<AnyGrammar>, result: Pattern): void => {
  const returned = new Set<number>()
  const collect = (pattern: Pattern): void => {
    switch (pattern._tag) {
      case "Ref": {
        if (pattern.scope !== scope) {
          throw new Error("gen: the return holds a ref bound by another gen; return it from the gen that bound it")
        }
        if (returned.has(pattern.slot)) {
          throw new Error(
            `gen: ${describeStep(steps[pattern.slot]!, pattern.slot)} is returned twice, so printing could not tell which copy to read`,
          )
        }
        returned.add(pattern.slot)
        return
      }
      case "Const":
        return
      case "Object":
        for (const [, field] of pattern.fields) collect(field)
        return
      case "Array":
        for (const item of pattern.items) collect(item)
    }
  }
  collect(result)
}
