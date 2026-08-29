import { Predicate } from "effect"

import type { Case, Expr, Pattern, RefExpr, ScopeId, Value } from "./core.ts"

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

export const frame = (scope: ScopeId, slotCount: number, parent: Frame | undefined): Frame => ({
  scope,
  parent,
  values: Array.from<Value>({ length: slotCount }).fill(Unbound),
})

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

  const object = evaluate(expr.object, env)
  if (object === Unbound || !Predicate.isObject(object)) return Unbound
  return Object.hasOwn(object, expr.key) ? object[expr.key] : Unbound
}

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
        object[key] = value
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
