import { Option, Predicate } from "effect"

import type { Case, Expr, Pattern, Value } from "./core.ts"
import { preview } from "./errors.ts"

export interface Env {
  readonly parent: Env | undefined
  readonly values: Map<number, Value>
}

export const child = (parent: Env | undefined): Env => ({ parent, values: new Map() })

export const lookup = (env: Env | undefined, id: number) => {
  for (let e = env; e !== undefined; e = e.parent) {
    if (e.values.has(id)) return Option.some(e.values.get(id))
  }
  return Option.none<Value>()
}

export const evaluate = (expr: Expr, env: Env | undefined): Option.Option<Value> => {
  switch (expr._tag) {
    case "Ref":
      return lookup(env, expr.id)
    case "Prop": {
      const object = evaluate(expr.object, env)
      if (Option.isNone(object)) return object
      const o = object.value
      return Predicate.hasProperty(o, expr.key) ? Option.some(o[expr.key]) : Option.none()
    }
  }
}

export const evaluateOrThrow = (expr: Expr, env: Env | undefined) =>
  Option.getOrThrowWith(
    evaluate(expr, env),
    () =>
      new Error(
        "a Grammar.Ref was read before its binding was parsed; a ref can only be used after the yield* that produced it, inside the same gen",
      ),
  )

export const materialize = (pattern: Pattern, env: Env): Value => {
  switch (pattern._tag) {
    case "Ref":
      return evaluateOrThrow(pattern, env)
    case "Const":
      return pattern.value
    case "Object":
      return Object.fromEntries(pattern.fields.map(([k, p]) => [k, materialize(p, env)]))
    case "Array":
      return pattern.items.map((p) => materialize(p, env))
  }
}

const keyOf = (value: Value) =>
  Predicate.isString(value)
    ? value
    : Predicate.isNumber(value) || Predicate.isBoolean(value)
      ? String(value)
      : preview(value)

export const keyCandidates = (key: string): ReadonlyArray<Value> => {
  const out: Array<Value> = [key]
  if (key === "true") out.push(true)
  if (key === "false") out.push(false)
  if (String(Number(key)) === key) out.push(Number(key))
  return out
}

export const caseFor = (cases: ReadonlyArray<Case>, value: Value) => {
  const key = keyOf(value)
  return cases.find((c) => c.key === key)
}
