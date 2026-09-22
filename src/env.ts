import { Predicate } from "effect"

import type { Case, Expr, RefExpr, ScopeId, Value } from "./core.ts"

export const Unbound = Symbol("effect-grammar/Unbound")

export interface Frame {
  readonly scope: ScopeId
  readonly parent: Frame | undefined
  readonly values: Array<Value>
}

export const frame = (scope: ScopeId, slotCount: number, parent: Frame | undefined): Frame => ({
  scope,
  parent,
  values: Array.from({ length: slotCount }, () => Unbound),
})

const lookup = (env: Frame | undefined, ref: RefExpr): Value => {
  for (let current = env; current !== undefined; current = current.parent) {
    if (current.scope === ref.scope) return current.values[ref.slot]
  }
  return Unbound
}

export const evaluate = (expr: Expr, env: Frame | undefined): Value => {
  if (expr._tag === "Ref") return lookup(env, expr)
  if (expr._tag === "Const") return expr.value

  const object = evaluate(expr.object, env)
  if (object === Unbound || !Predicate.isObjectOrArray(object)) return Unbound
  // SAFETY: objects and arrays support property-key access; only own fields are evaluated.
  const fields = object as Readonly<Record<PropertyKey, Value>>
  return Object.hasOwn(fields, expr.key) ? fields[expr.key] : Unbound
}

export const caseFor = (cases: ReadonlyArray<Case>, value: Value) =>
  cases.find((matchCase) => Object.is(matchCase.key, value))
