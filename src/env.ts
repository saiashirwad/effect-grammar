import { Option, Predicate } from "effect"

import type { Case, Expr, MatchKey, Pattern, ScopeId, Value } from "./core.ts"

const Unbound = Symbol("effect-grammar/Unbound")

type Slot = Value

export interface Frame {
  readonly scope: ScopeId
  readonly parent: Frame | undefined
  readonly values: Array<Slot>
}

export const frame = (scope: ScopeId, slotCount: number, parent: Frame | undefined): Frame => ({
  scope,
  parent,
  values: Array.from({ length: slotCount }, () => Unbound),
})

export const cloneFrame = (source: Frame): Frame => ({
  scope: source.scope,
  parent: source.parent,
  values: source.values.slice(),
})

export const bind = (target: Frame, slot: number, value: Value): void => {
  target.values[slot] = value
}

export const localValue = (target: Frame, slot: number): Option.Option<Value> => {
  const value = target.values[slot]
  return value === Unbound ? Option.none() : Option.some(value)
}

export const lookup = (env: Frame | undefined, ref: Extract<Expr, { _tag: "Ref" }>) => {
  for (let current = env; current !== undefined; current = current.parent) {
    if (current.scope !== ref.scope) continue
    return localValue(current, ref.slot)
  }
  return Option.none<Value>()
}

export const evaluate = (expr: Expr, env: Frame | undefined): Option.Option<Value> => {
  if (expr._tag === "Ref") return lookup(env, expr)

  const object = evaluate(expr.object, env)
  if (Option.isNone(object) || !Predicate.isObject(object.value)) return Option.none()
  return Object.hasOwn(object.value, expr.key) ? Option.some(object.value[expr.key]) : Option.none()
}

export const materialize = (pattern: Pattern, env: Frame): Option.Option<Value> => {
  switch (pattern._tag) {
    case "Ref":
      return lookup(env, pattern)
    case "Const":
      return Option.some(pattern.value)
    case "Object": {
      const fields: Array<readonly [string, Value]> = []
      for (const [key, field] of pattern.fields) {
        const value = materialize(field, env)
        if (Option.isNone(value)) return value
        fields.push([key, value.value])
      }
      return Option.some(Object.fromEntries(fields))
    }
    case "Array": {
      const items: Array<Value> = []
      for (const item of pattern.items) {
        const value = materialize(item, env)
        if (Option.isNone(value)) return value
        items.push(value.value)
      }
      return Option.some(items)
    }
  }
}

export const caseFor = (cases: ReadonlyArray<Case>, value: Value) =>
  cases.find((matchCase) => Object.is(matchCase.key, value))

export const isMatchKey = (value: Value): value is MatchKey =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)

export const isCount = (value: Value): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0
