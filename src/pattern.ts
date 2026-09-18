import { Equal, Predicate } from "effect"

import type { Pattern, Value } from "./core.ts"
import { bind, type Frame } from "./env.ts"
import { exceptionMessage, type PrintIssue } from "./errors.ts"

export const ownKeys = (
  value: Readonly<Record<string, Value>>,
  fields: ReadonlyArray<string>,
): Array<string | symbol> | PrintIssue => {
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
    for (const key of keys) Object.getOwnPropertyDescriptor(value, key)
  } catch (error) {
    return {
      _tag: "InvalidValue",
      expected: `an inspectable object with exactly the fields ${fields.join(", ")}`,
      actual: value,
      detail: `could not inspect own fields: ${exceptionMessage(error)}`,
    }
  }
  return keys.every((key) => Predicate.isString(key) && fields.includes(key))
    ? keys
    : {
        _tag: "InvalidValue",
        expected: `exactly the fields ${fields.join(", ")}`,
        actual: value,
        detail: "unexpected own field",
      }
}

export const unifyPattern = (
  pattern: Pattern,
  value: Value,
  values: Frame,
): PrintIssue | undefined => {
  switch (pattern._tag) {
    case "Ref":
      bind(values, pattern.slot, value)
      return undefined
    case "Const":
      return Equal.equals(value, pattern.value)
        ? undefined
        : { _tag: "ConstantMismatch", expected: pattern.value, actual: value }
    case "Object": {
      if (!Predicate.isObject(value) || Array.isArray(value)) {
        return { _tag: "TypeMismatch", expected: "an object", actual: value }
      }
      const keys = ownKeys(
        value,
        pattern.fields.map(([key]) => key),
      )
      if (!Array.isArray(keys)) return keys
      for (const [key, field] of pattern.fields) {
        if (!keys.includes(key)) {
          return { _tag: "AtPath", path: key, issue: { _tag: "MissingField", field: key } }
        }
        let fieldValue: Value
        try {
          fieldValue = value[key]
        } catch (error) {
          return {
            _tag: "AtPath",
            path: key,
            issue: {
              _tag: "InvalidValue",
              expected: "a readable field",
              actual: value,
              detail: exceptionMessage(error),
            },
          }
        }
        const issue = unifyPattern(field, fieldValue, values)
        if (issue !== undefined) return { _tag: "AtPath", path: key, issue }
      }
      return undefined
    }
    case "Array": {
      if (!Array.isArray(value))
        return { _tag: "TypeMismatch", expected: "an array", actual: value }
      if (value.length !== pattern.items.length) {
        return {
          _tag: "InvalidValue",
          expected: `${pattern.items.length} items`,
          actual: value.length,
          detail: `expected ${pattern.items.length} items, got ${value.length}`,
        }
      }
      for (const [index, item] of pattern.items.entries()) {
        const issue = unifyPattern(item, value[index], values)
        if (issue !== undefined) return { _tag: "AtPath", path: index, issue }
      }
      return undefined
    }
  }
}
