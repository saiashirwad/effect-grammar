import { Predicate, type Types } from "effect"

import {
  type AnyGrammar,
  type Expr,
  isGrammar,
  nodeOf,
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
  // The fields of the bound object, when the grammar declares them; spreading the ref yields these.
  readonly keys: ReadonlyArray<string> | undefined
}

// The fields a grammar's output is known to have.
export const keysOf = (grammar: AnyGrammar): ReadonlyArray<string> | undefined => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Gen":
      return node.result._tag === "Object" ? node.result.fields.map(([key]) => key) : undefined
    case "Transform":
      return node.keys
    case "Wrap":
    case "Label":
      return keysOf(node.inner)
    default:
      return undefined
  }
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
// Spreading a ref enumerates its known fields, so `{ ...flags }` returns each field's ref.
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
  ownKeys(target) {
    return [...(entryOf(target).keys ?? [])]
  },
  getOwnPropertyDescriptor(target, key) {
    const entry = entryOf(target)
    if (!Predicate.isString(key) || !entry.keys?.includes(key)) return undefined
    return {
      value: refFor({ _tag: "Prop", object: entry.expr, key }, entry.scope),
      enumerable: true,
      configurable: true,
      writable: false,
    }
  },
}

export const refFor = <A>(expr: Expr, scope: Scope, keys?: ReadonlyArray<string>): Ref<A> => {
  const target = new RefImpl<A>()
  const ref = new Proxy(target, refHandler)
  const entry: RefEntry = { expr, scope, keys }
  refs.set(ref, entry)
  refs.set(target, entry)
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
    if (expr._tag === "Ref") return expr
    if (expr._tag === "Prop" && expr.object._tag === "Ref" && Predicate.isString(expr.key)) {
      return { _tag: "Prop", object: expr.object, key: expr.key }
    }
    throw new Error(
      "gen: the return holds a nested property of a ref; return the ref, one of its fields, or its spread",
    )
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

// Printing reads a slot from wherever the pattern mentions it, so a ref may appear once:
// either whole, or through every one of its fields.
export const assertRefsReturnedOnce = (scope: ScopeId, steps: ReadonlyArray<AnyGrammar>, result: Pattern): void => {
  const whole = new Set<number>()
  const byField = new Map<number, Set<string>>()
  const collect = (pattern: Pattern): void => {
    switch (pattern._tag) {
      case "Ref":
      case "Prop": {
        const ref = pattern._tag === "Ref" ? pattern : pattern.object
        if (ref.scope !== scope) {
          throw new Error("gen: the return holds a ref bound by another gen; return it from the gen that bound it")
        }
        const step = describeStep(steps[ref.slot]!, ref.slot)
        const fields = byField.get(ref.slot)
        if (whole.has(ref.slot) || (pattern._tag === "Ref" && fields !== undefined)) {
          throw new Error(`gen: ${step} is returned twice, so printing could not tell which copy to read`)
        }
        if (pattern._tag === "Ref") {
          whole.add(ref.slot)
          return
        }
        if (fields?.has(pattern.key)) {
          throw new Error(`gen: field ${JSON.stringify(pattern.key)} of ${step} is returned twice`)
        }
        byField.set(ref.slot, (fields ?? new Set()).add(pattern.key))
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

  for (const [slot, fields] of byField) {
    const step = describeStep(steps[slot]!, slot)
    const keys = keysOf(steps[slot]!)
    if (keys === undefined) {
      throw new Error(`gen: ${step} has no known fields, so it cannot be returned field by field; return the whole ref`)
    }
    const missing = keys.filter((key) => !fields.has(key))
    if (missing.length > 0) {
      throw new Error(
        `gen: ${step} is returned field by field but ${missing.map((key) => JSON.stringify(key)).join(", ")} ${missing.length === 1 ? "is" : "are"} missing, so printing could not rebuild it; spread the whole ref`,
      )
    }
  }
}
