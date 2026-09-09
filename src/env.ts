import { Predicate } from "effect"

import {
  type Case,
  type Count,
  type Expr,
  type Pattern,
  type RefExpr,
  type ScopeId,
  unsafeToNever,
  type Value,
} from "./core.ts"

/**
 * Sentinel for "no value has been bound here". Distinguished from `undefined`
 * because slots can legitimately hold `undefined` (e.g. `optional`).
 */
export const Unbound = Symbol("effect-grammar/Unbound")

export type BoundValue = Value | typeof Unbound

export interface Frame {
  readonly scope: ScopeId
  readonly parent: Frame | undefined
  readonly values: Array<Value>
}

export const frame = (scope: ScopeId, slotCount: number, parent: Frame | undefined): Frame => {
  // Push (not `Array.from({ length }).fill()`): the slots array must stay packed.
  const values: Array<Value> = []
  for (let slot = 0; slot < slotCount; slot++) values.push(Unbound)
  return { scope, parent, values }
}

export const bind = (target: Frame, slot: number, value: Value): void => {
  target.values[slot] = value
}

export const lookup = (env: Frame | undefined, ref: RefExpr): BoundValue => {
  for (let current = env; current !== undefined; current = current.parent) {
    if (current.scope !== ref.scope) continue
    return current.values[ref.slot]
  }
  return Unbound
}

export const evaluate = (expr: Expr, env: Frame | undefined): BoundValue => {
  if (expr._tag === "Ref") return lookup(env, expr)
  if (expr._tag === "Map") {
    const inner = evaluate(expr.expr, env)
    return inner === Unbound ? Unbound : expr.f(unsafeToNever(inner))
  }

  const object = evaluate(expr.object, env)
  if (object === Unbound) return Unbound
  if (expr.key === "length" && (Predicate.isString(object) || object instanceof Uint8Array)) {
    return object.length
  }
  if (!Predicate.isObject(object)) return Unbound
  return Object.hasOwn(object, expr.key) ? object[expr.key] : Unbound
}

export const evaluateCount = (count: Count, env: Frame | undefined): BoundValue =>
  Predicate.isNumber(count) ? count : evaluate(count, env)

export const materialize = (pattern: Pattern, env: Frame): BoundValue => {
  switch (pattern._tag) {
    case "Ref":
      return lookup(env, pattern)
    case "Const":
      return pattern.value
    case "Object": {
      const object: Record<string, Value> = {}
      for (const [key, field] of pattern.fields) {
        const value = materialize(field, env)
        if (value === Unbound) return Unbound
        Object.defineProperty(object, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
      return object
    }
    case "Array": {
      const items: Array<Value> = []
      for (const item of pattern.items) {
        const value = materialize(item, env)
        if (value === Unbound) return Unbound
        items.push(value)
      }
      return items
    }
  }
}

export const caseFor = (cases: ReadonlyArray<Case>, value: Value) =>
  cases.find((matchCase) => Object.is(matchCase.key, value))

export const isCount = (value: Value): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0
