import { Option, Predicate } from "effect"

import type { Expr, Pattern, Value } from "./core.ts"
import { preview } from "./errors.ts"

/** The values bound so far, one frame per `gen` being parsed or printed. */
export interface Env {
  readonly parent: Env | undefined
  readonly values: Map<number, Value>
}

export const child = (parent: Env | undefined): Env => ({ parent, values: new Map() })

export const lookup = (env: Env | undefined, id: number): Option.Option<Value> => {
  for (let e = env; e !== undefined; e = e.parent) {
    if (e.values.has(id)) return Option.some(e.values.get(id))
  }
  return Option.none()
}

/** `None` when the root binding is not in `env` or a projection has nothing to read from. */
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

export const evaluateOrThrow = (expr: Expr, env: Env | undefined): Value => {
  const v = evaluate(expr, env)
  if (Option.isSome(v)) return v.value
  throw new Error(
    "a Grammar.Ref was read before its binding was parsed; a ref can only be used after the yield* that produced it, inside the same gen",
  )
}

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

/** The `match` case key a value selects: literals by their string form. */
export const keyOf = (value: Value): string =>
  Predicate.isString(value)
    ? value
    : Predicate.isNumber(value) || Predicate.isBoolean(value)
      ? String(value)
      : preview(value)
