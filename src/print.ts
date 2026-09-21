import { Equal, Predicate, Result } from "effect"

import {
  type Grammar,
  type GrammarInternal,
  type Node,
  nodeOf,
  type Pattern,
  resolve,
  type ScopeId,
  unsafeToNever,
  type Value,
} from "./core.ts"
import { bind, caseFor, copyFields, evaluate, type Frame, frame, nonByte, isCount, toBytes, Unbound } from "./env.ts"
import { describeRoundTrip, exceptionMessage, preview, PrintError, type PrintIssue } from "./errors.ts"
import { reparse } from "./parse.ts"
import { describe, describeStep } from "./render.ts"

type RoundTripIssue = Extract<PrintIssue, { _tag: "RoundTrip" }>

const roundTripIssue = (
  grammar: GrammarInternal,
  value: Value,
  printed: string,
  env: Frame | undefined,
): RoundTripIssue | undefined => {
  const back = reparse(grammar, printed, env)
  if (Result.isFailure(back)) return { _tag: "RoundTrip", value, printed, error: back.failure.message }
  return Equal.equals(back.success, value) ? undefined : { _tag: "RoundTrip", value, printed, parsed: back.success }
}

const bindingPath = (
  pattern: Pattern,
  scope: ScopeId,
  slot: number,
  path: ReadonlyArray<string | number>,
): ReadonlyArray<string | number> | undefined => {
  switch (pattern._tag) {
    case "Ref":
      return pattern.scope === scope && pattern.slot === slot ? path : undefined
    case "Const":
      return undefined
    case "Object":
      for (const [key, field] of pattern.fields) {
        const found = bindingPath(field, scope, slot, [...path, key])
        if (found !== undefined) return found
      }
      return undefined
    case "Array":
      for (const [index, item] of pattern.items.entries()) {
        const found = bindingPath(item, scope, slot, [...path, index])
        if (found !== undefined) return found
      }
      return undefined
  }
}

const ownKeys = (
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

const unifyPattern = (pattern: Pattern, value: Value, values: Frame): Result.Result<void, PrintIssue> => {
  switch (pattern._tag) {
    case "Ref":
      bind(values, pattern.slot, value)
      return Result.void
    case "Const":
      return Equal.equals(value, pattern.value)
        ? Result.void
        : Result.fail({ _tag: "ConstantMismatch", expected: pattern.value, actual: value })
    case "Object": {
      if (!Predicate.isObject(value)) {
        return Result.fail({ _tag: "TypeMismatch", expected: "an object", actual: value })
      }
      const keys = ownKeys(
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
        const result = unifyPattern(field, fieldValue, values)
        if (Result.isFailure(result)) {
          return Result.fail({ _tag: "AtPath", path: key, issue: result.failure })
        }
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
        const result = unifyPattern(item, value[index], values)
        if (Result.isFailure(result)) {
          return Result.fail({ _tag: "AtPath", path: index, issue: result.failure })
        }
      }
      return Result.void
    }
  }
}

const printGrammar = (
  grammar: GrammarInternal,
  value: Value,
  env: Frame | undefined,
  suspended: Set<Node> = new Set(),
): Result.Result<string, PrintIssue> => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return Result.succeed(node.value)
    case "Regex": {
      if (!Predicate.isString(value)) return Result.fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      const expression = new RegExp(node.source, `${node.flags}y`)
      const match = expression.exec(value)
      if (match === null || match[0].length !== value.length) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: node.name,
          actual: value,
          detail: `${JSON.stringify(value)} does not match /${node.source}/`,
        })
      }
      return Result.succeed(value)
    }
    case "Gen": {
      const local = frame(node.scope, node.slotCount, env)
      const result = unifyPattern(node.result, value, local)
      if (Result.isFailure(result)) return Result.fail(result.failure)

      let text = ""
      for (const [index, step] of node.steps.entries()) {
        const result =
          step._tag === "Silent"
            ? printGrammar(step.grammar, undefined, local)
            : local.values[step.slot] === Unbound
              ? Result.fail<PrintIssue>({
                  _tag: "MissingBinding",
                  binding: describeStep(step, index),
                })
              : printGrammar(step.grammar, local.values[step.slot], local)
        if (Result.isFailure(result)) {
          const path = step._tag === "Bind" ? bindingPath(node.result, node.scope, step.slot, []) : undefined
          return Result.fail(
            path === undefined
              ? result.failure
              : path.reduceRight<PrintIssue>((issue, path) => ({ _tag: "AtPath", path, issue }), result.failure),
          )
        }
        text += result.success
      }
      return Result.succeed(text)
    }
    case "Wrap":
      return Result.gen(function* () {
        const open = yield* printGrammar(node.open, undefined, env)
        const inner = yield* printGrammar(node.inner, value, env)
        const close = yield* printGrammar(node.close, undefined, env)
        return open + inner + close
      })
    case "Choice": {
      if (node.on !== undefined) {
        const { tag, keys } = node.on
        if (!Predicate.isObject(value) || !Object.hasOwn(value, tag)) {
          return Result.fail({
            _tag: "TypeMismatch",
            expected: `an object with a ${tag} field`,
            actual: value,
          })
        }
        const key = value[tag]
        const index = keys.findIndex((candidate) => Object.is(candidate, key))
        if (index === -1) {
          return Result.fail({
            _tag: "InvalidValue",
            expected: `${tag} to be one of ${keys.map(preview).join(", ")}`,
            actual: key,
          })
        }
        return printGrammar(node.options[index]!, value, env)
      }
      const issues: Array<PrintIssue> = []
      for (const option of node.options) {
        const result = printGrammar(option, value, env)
        if (Result.isFailure(result)) {
          issues.push(result.failure)
          continue
        }
        if (node.checked !== true) return result
        const issue = roundTripIssue(grammar, value, result.success, env)
        if (issue === undefined) return result
        issues.push({
          _tag: "InvalidValue",
          expected: describe(option),
          actual: value,
          detail: describeRoundTrip(issue),
        })
      }
      return Result.fail({ _tag: "NoAlternative", actual: value, issues })
    }
    case "Many": {
      if (!Array.isArray(value)) return Result.fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length < node.min || value.length > node.max) {
        const expected = node.max === Number.POSITIVE_INFINITY ? `at least ${node.min}` : `${node.min}..${node.max}`
        return Result.fail({
          _tag: "InvalidValue",
          expected: `${expected} items`,
          actual: value,
          detail: `expected ${expected} items, got ${value.length}`,
        })
      }
      const separator = printGrammar(node.sep, undefined, env)
      if (Result.isFailure(separator)) return separator
      let text = ""
      for (const [index, item] of value.entries()) {
        const result = printGrammar(node.inner, item, env)
        if (Result.isFailure(result)) {
          return Result.fail({ _tag: "AtPath", path: index, issue: result.failure })
        }
        text += index === 0 ? result.success : separator.success + result.success
      }
      return Result.succeed(text)
    }
    case "Optional":
      return value === undefined ? Result.succeed("") : printGrammar(node.inner, value, env)
    case "Transform": {
      try {
        if (node.is?.(unsafeToNever(value)) === false) {
          return Result.fail({
            _tag: "InvalidValue",
            expected: node.name ?? describe(node.inner),
            actual: value,
          })
        }
        const encoded = node.encode(unsafeToNever(value))
        return Result.isFailure(encoded)
          ? Result.fail({
              _tag: "InvalidValue",
              expected: node.name ?? describe(node.inner),
              actual: value,
              detail: encoded.failure.message,
            })
          : printGrammar(node.inner, encoded.success, env)
      } catch (error) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: node.name ?? describe(node.inner),
          actual: value,
          detail: exceptionMessage(error),
        })
      }
    }
    case "Skip":
      return printGrammar(node.inner, node.printAs, env)
    case "Label":
      return printGrammar(node.inner, value, env)
    case "Suspend": {
      if (suspended.has(node)) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: "a productive recursive grammar",
          actual: value,
          detail: `suspend${node.name === undefined ? "" : ` ${JSON.stringify(node.name)}`} recursed without consuming a value`,
        })
      }
      let target: GrammarInternal
      try {
        target = resolve(node)
      } catch (error) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: "a valid suspended grammar",
          actual: value,
          detail: exceptionMessage(error),
        })
      }
      suspended.add(node)
      try {
        return printGrammar(target, value, env, suspended)
      } finally {
        suspended.delete(node)
      }
    }
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return Result.fail({ _tag: "MissingBinding", binding: "match selector" })
      const matchCase = caseFor(node.cases, key)
      return matchCase === undefined
        ? Result.fail({
            _tag: "InvalidValue",
            expected: `a match case for ${preview(key)}`,
            actual: value,
          })
        : printGrammar(matchCase.grammar, value, env)
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return Result.fail({ _tag: "MissingBinding", binding: "take count" })
      if (!isCount(count)) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: "a non-negative count",
          actual: count,
        })
      }
      if (!Predicate.isString(value)) return Result.fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      if (node.unit === "char") {
        return value.length === count
          ? Result.succeed(value)
          : Result.fail({ _tag: "InvalidValue", expected: `${count} UTF-16 code units`, actual: value })
      }
      if (nonByte.test(value)) {
        return Result.fail({ _tag: "InvalidValue", expected: "a string of bytes", actual: value })
      }
      // Report bytes rather than the internal binary string.
      return value.length === count
        ? Result.succeed(value)
        : Result.fail({ _tag: "InvalidValue", expected: `${count} bytes`, actual: toBytes(value) })
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return Result.fail({ _tag: "MissingBinding", binding: "repeat count" })
      if (!isCount(count)) {
        return Result.fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
      }
      if (!Array.isArray(value)) return Result.fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== count) {
        return Result.fail({ _tag: "InvalidValue", expected: `${count} items`, actual: value.length })
      }
      let text = ""
      for (const [index, item] of value.entries()) {
        const result = printGrammar(node.inner, item, env)
        if (Result.isFailure(result)) {
          return Result.fail({ _tag: "AtPath", path: index, issue: result.failure })
        }
        text += result.success
      }
      return Result.succeed(text)
    }
    case "Merge": {
      if (!Predicate.isObject(value)) {
        return Result.fail({ _tag: "TypeMismatch", expected: "an object", actual: value })
      }
      const keys = ownKeys(
        value,
        node.parts.flatMap((part) => part.keys),
      )
      if (Result.isFailure(keys)) return Result.fail(keys.failure)

      let text = ""
      for (const part of node.parts) {
        const fields: Record<string, Value> = {}
        try {
          copyFields(fields, value, part.keys)
        } catch (error) {
          return Result.fail({
            _tag: "InvalidValue",
            expected: "readable fields",
            actual: value,
            detail: exceptionMessage(error),
          })
        }
        const result = printGrammar(part.grammar, fields, env)
        if (Result.isFailure(result)) return result
        text += result.success
      }
      return Result.succeed(text)
    }
  }
}

export const printUnknown = (grammar: GrammarInternal, value: Value): Result.Result<string, PrintError> =>
  Result.mapError(printGrammar(grammar, value, undefined), (issue) => new PrintError({ issue }))

// Print with the grammar's branches and spellings, without a round-trip check. See `printChecked`.
export const print: <A>(grammar: Grammar<A>, value: A) => Result.Result<string, PrintError> = printUnknown

export const printCheckedUnknown = (grammar: GrammarInternal, value: Value): Result.Result<string, PrintError> =>
  Result.flatMap(printUnknown(grammar, value), (printed) => {
    const issue = roundTripIssue(grammar, value, printed, undefined)
    return issue === undefined ? Result.succeed(printed) : Result.fail(new PrintError({ issue }))
  })

// Print a value and verify that parsing the whole output returns the original value.
export const printChecked: typeof print = printCheckedUnknown
