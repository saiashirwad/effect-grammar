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
  if (expr._tag === "Count") return expr.value

  const object = evaluate(expr.object, env)
  if (object === Unbound || !Predicate.isObject(object)) return Unbound
  return Object.hasOwn(object, expr.key) ? object[expr.key] : Unbound
}

export const defineField = (object: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

export const copyFields = (
  target: Record<string, Value>,
  source: Readonly<Record<string, Value>>,
  keys: ReadonlyArray<string>,
): void => {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) defineField(target, key, source[key])
  }
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
        defineField(object, key, value)
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

export const nonByte = /[^\0-\xff]/

export const isByteString = (text: string): boolean => !nonByte.test(text)
