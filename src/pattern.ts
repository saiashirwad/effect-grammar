import { Equal, Predicate, Result } from "effect"

import { isGrammar, type RefExpr, type ScopeId, type Value } from "./core.ts"
import { evaluate, type Frame, Unbound } from "./env.ts"
import { exceptionMessage, type PrintIssue } from "./errors.ts"
import { atPath, catchResult, inspect } from "./internal/runtime.ts"
import { entryOf, isRef } from "./ref.ts"

export type Pattern =
  | RefExpr
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, Pattern]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<Pattern> }

export interface ReturnPattern {
  readonly tree: Pattern
  /** Presence records a returned slot; its path is shared by rendering and print errors. */
  readonly bindings: ReadonlyMap<number, ReadonlyArray<string | number>>
}

export const returnPattern = (tree: Pattern, scope: ScopeId, describeSlot: (slot: number) => string): ReturnPattern => {
  const bindings = new Map<number, ReadonlyArray<string | number>>()
  const collect = (pattern: Pattern, path: ReadonlyArray<string | number>): void => {
    switch (pattern._tag) {
      case "Ref":
        if (pattern.scope !== scope) {
          throw new Error("gen: the return holds a ref bound by another gen; return it from the gen that bound it")
        }
        if (bindings.has(pattern.slot)) {
          throw new Error(
            `gen: ${describeSlot(pattern.slot)} is returned twice, so printing could not tell which copy to read`,
          )
        }
        bindings.set(pattern.slot, path)
        return
      case "Const":
        return
      case "Object":
        for (const [key, field] of pattern.fields) collect(field, [...path, key])
        return
      case "Array":
        pattern.items.forEach((item, index) => collect(item, [...path, index]))
    }
  }
  collect(tree, [])
  return { tree, bindings }
}

export const toPattern = (value: Value, active: WeakSet<object> = new WeakSet()): Pattern => {
  if (isRef(value)) {
    const { expr } = entryOf(value)
    if (expr._tag === "Ref") return expr
    throw new Error(
      "gen: the return holds a property ref; return the whole bound ref and use transform to reshape its value",
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

    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
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

const setOwn = (object: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

export const materialize = (pattern: Pattern, env: Frame): Value => {
  switch (pattern._tag) {
    case "Ref":
      return evaluate(pattern, env)
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

const validateOwnKeys = (
  value: Readonly<Record<string, Value>>,
  fields: ReadonlyArray<string>,
): Result.Result<Array<string | symbol>, PrintIssue> => {
  const keys = inspect(
    value,
    `an inspectable object with exactly the fields ${fields.join(", ")}`,
    () => {
      const keys = Reflect.ownKeys(value)
      for (const key of keys) Object.getOwnPropertyDescriptor(value, key)
      return keys
    },
    (message) => `could not inspect own fields: ${message}`,
  )
  if (Result.isFailure(keys)) return keys
  return keys.success.every((key) => Predicate.isString(key) && fields.includes(key))
    ? keys
    : Result.fail({
        _tag: "InvalidValue",
        expected: `exactly the fields ${fields.join(", ")}`,
        actual: value,
        detail: "unexpected own field",
      })
}

export const unifyPattern = (pattern: Pattern, value: Value, env: Frame): Result.Result<void, PrintIssue> => {
  return catchResult(
    () => unifyNode(pattern, value, env),
    (error): PrintIssue => ({
      _tag: "InvalidValue",
      expected: `an inspectable ${pattern._tag.toLowerCase()} pattern value`,
      actual: value,
      detail: exceptionMessage(error),
    }),
  )
}

const unifyNode = (pattern: Pattern, value: Value, env: Frame): Result.Result<void, PrintIssue> => {
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
        const result = atPath(
          key,
          Result.flatMap(
            inspect(value, "a readable field", () => value[key]),
            (fieldValue) => unifyPattern(field, fieldValue, env),
          ),
        )
        if (Result.isFailure(result)) return result
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
        const result = atPath(
          index,
          Result.flatMap(
            inspect(value, "a readable array element", () => value[index]),
            (itemValue) => unifyPattern(item, itemValue, env),
          ),
        )
        if (Result.isFailure(result)) return result
      }
      return Result.void
    }
  }
}
