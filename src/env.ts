import { Equal, Predicate, Result } from "effect"

import type { Case, Expr, Pattern, RefExpr, ScopeId, Value } from "./core.ts"
import { exceptionMessage, type PrintIssue } from "./errors.ts"

// An unbound slot; `undefined` is a valid bound value.
export const Unbound = Symbol("effect-grammar/Unbound")

// One gen's slots. A ref finds its frame by scope, so a gen nested in a repetition still resolves.
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
  if (object === Unbound || !Predicate.isObject(object)) return Unbound
  return Object.hasOwn(object, expr.key) ? object[expr.key] : Unbound
}

export const caseFor = (cases: ReadonlyArray<Case>, value: Value) =>
  cases.find((matchCase) => Object.is(matchCase.key, value))

// Plain assignment would follow a `__proto__` key; defining the property does not.
const setOwn = (object: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

export const copyFields = (
  target: Record<string, Value>,
  source: Readonly<Record<string, Value>>,
  keys: ReadonlyArray<string>,
): void => {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) setOwn(target, key, source[key])
  }
}

// Parsing: build the gen's return value from its bound slots.
export const materialize = (pattern: Pattern, env: Frame): Value => {
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
        setOwn(object, key, value)
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

export const validateOwnKeys = (
  value: Readonly<Record<string, Value>>,
  fields: ReadonlyArray<string>,
): Result.Result<Array<string | symbol>, PrintIssue> => {
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
    for (const key of keys) Object.getOwnPropertyDescriptor(value, key)
  } catch (error) {
    return Result.fail({
      _tag: "InvalidValue",
      expected: `an inspectable object with exactly the fields ${fields.join(", ")}`,
      actual: value,
      detail: `could not inspect own fields: ${exceptionMessage(error)}`,
    })
  }
  return keys.every((key) => Predicate.isString(key) && fields.includes(key))
    ? Result.succeed(keys)
    : Result.fail({
        _tag: "InvalidValue",
        expected: `exactly the fields ${fields.join(", ")}`,
        actual: value,
        detail: "unexpected own field",
      })
}

// Printing: take a value apart along the pattern, binding each ref's slot.
export const unifyPattern = (pattern: Pattern, value: Value, env: Frame): Result.Result<void, PrintIssue> => {
  switch (pattern._tag) {
    case "Ref":
      env.values[pattern.slot] = value
      return Result.void
    case "Const":
      return Equal.equals(value, pattern.value)
        ? Result.void
        : Result.fail({ _tag: "ConstantMismatch", expected: pattern.value, actual: value })
    case "Object": {
      if (!Predicate.isObject(value)) {
        return Result.fail({ _tag: "TypeMismatch", expected: "an object", actual: value })
      }
      const keys = validateOwnKeys(
        value,
        pattern.fields.map(([key]) => key),
      )
      if (Result.isFailure(keys)) return Result.fail(keys.failure)
      for (const [key, field] of pattern.fields) {
        if (!keys.success.includes(key)) {
          return Result.fail({ _tag: "AtPath", path: key, issue: { _tag: "MissingField", field: key } })
        }
        let fieldValue: Value
        try {
          fieldValue = value[key]
        } catch (error) {
          return Result.fail({
            _tag: "AtPath",
            path: key,
            issue: {
              _tag: "InvalidValue",
              expected: "a readable field",
              actual: value,
              detail: exceptionMessage(error),
            },
          })
        }
        const result = unifyPattern(field, fieldValue, env)
        if (Result.isFailure(result)) return Result.fail({ _tag: "AtPath", path: key, issue: result.failure })
      }
      return Result.void
    }
    case "Array": {
      if (!Array.isArray(value)) return Result.fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== pattern.items.length) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: `${pattern.items.length} items`,
          actual: value.length,
          detail: `expected ${pattern.items.length} items, got ${value.length}`,
        })
      }
      for (const [index, item] of pattern.items.entries()) {
        const result = unifyPattern(item, value[index], env)
        if (Result.isFailure(result)) return Result.fail({ _tag: "AtPath", path: index, issue: result.failure })
      }
      return Result.void
    }
  }
}
