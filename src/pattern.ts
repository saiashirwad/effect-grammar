import { Equal, Predicate } from "effect"

import type { Pattern, Value } from "./core.ts"
import { bind, type Frame } from "./env.ts"
import type { PrintIssue } from "./errors.ts"

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
      for (const [key, field] of pattern.fields) {
        if (!Object.hasOwn(value, key)) {
          return { _tag: "AtPath", path: key, issue: { _tag: "MissingField", field: key } }
        }
        const issue = unifyPattern(field, value[key], values)
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
