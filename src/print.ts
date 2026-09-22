import { Equal, Predicate, Result } from "effect"

import { type AnyGrammar, type Grammar, isCount, type Node, nodeOf, resolve, type Value } from "./core.ts"
import { caseFor, evaluate, type Frame, frame, Unbound } from "./env.ts"
import { describeRoundTrip, exceptionMessage, preview, PrintError, type PrintIssue } from "./errors.ts"
import { describe, describeStep } from "./internal/describe.ts"
import { isSyntaxOnly } from "./internal/syntax.ts"
import { parseWithEnv } from "./parse.ts"
import { unifyPattern } from "./pattern.ts"

interface State {
  readonly activeFor: Map<Node, Set<Value>>
}

type Printed = Result.Result<string, PrintIssue>

const fail = (issue: PrintIssue): Printed => Result.fail(issue)

const invalid = (expected: string, actual: Value, detail?: string): Printed =>
  fail({ _tag: "InvalidValue", expected, actual, detail })

const atPath = (path: string | number, result: Printed): Printed =>
  Result.mapError(result, (issue) => ({ _tag: "AtPath", path, issue }))

const roundTripIssue = (
  grammar: AnyGrammar,
  value: Value,
  printed: string,
  env: Frame | undefined,
): Extract<PrintIssue, { _tag: "RoundTrip" }> | undefined => {
  const back = parseWithEnv(grammar, printed, env)
  if (Result.isFailure(back)) return { _tag: "RoundTrip", value, printed, error: back.failure.message }
  return Equal.equals(back.success, value) ? undefined : { _tag: "RoundTrip", value, printed, parsed: back.success }
}

const printCount = (count: Value, what: string): Result.Result<number, PrintIssue> => {
  if (count === Unbound) return Result.fail({ _tag: "MissingBinding", binding: what })
  if (!isCount(count)) return Result.fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
  return Result.succeed(count)
}

const printItems = (
  inner: AnyGrammar,
  items: ReadonlyArray<Value>,
  separator: string,
  env: Frame | undefined,
  state: State,
): Printed => {
  let text = ""
  for (const [index, item] of items.entries()) {
    const result = printGrammar(inner, item, env, state)
    if (Result.isFailure(result)) return atPath(index, result)
    text += index === 0 ? result.success : separator + result.success
  }
  return Result.succeed(text)
}

const printGrammar = (grammar: AnyGrammar, value: Value, env: Frame | undefined, state: State): Printed => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return Result.succeed(node.value)
    case "Regex": {
      if (!Predicate.isString(value)) return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      const match = new RegExp(node.source, `${node.flags}y`).exec(value)
      if (match === null || match[0].length !== value.length) return invalid(`/${node.source}/`, value)
      return Result.succeed(value)
    }
    case "Take": {
      const count = printCount(evaluate(node.count, env), "take count")
      if (Result.isFailure(count)) return Result.fail(count.failure)
      if (!Predicate.isString(value)) return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      return value.length === count.success
        ? Result.succeed(value)
        : invalid(`${count.success} character${count.success === 1 ? "" : "s"}`, value)
    }
    case "Gen": {
      const local = frame(node.scope, node.steps.length, env)
      const unified = unifyPattern(node.result.tree, value, local)
      if (Result.isFailure(unified)) return Result.fail(unified.failure)

      let text = ""
      for (const [slot, step] of node.steps.entries()) {
        const bound = local.values[slot]
        const result = printGrammar(step, bound === Unbound ? undefined : bound, local, state)
        if (Result.isFailure(result)) {
          // Error classification must not resolve suspensions that execution never reached.
          if (bound === Unbound && !isSyntaxOnly(step, (suspension) => suspension.resolved)) {
            return invalid(
              describeStep(step, slot),
              undefined,
              "parsed but not returned, so there is no value to print it from; return it, or discard it with skip",
            )
          }
          const path = node.result.bindings.get(slot) ?? []
          return path.reduceRight<Printed>((inner, part) => atPath(part, inner), result)
        }
        text += result.success
      }
      return Result.succeed(text)
    }
    case "Choice": {
      const issues: Array<PrintIssue> = []
      for (const option of node.options) {
        const result = printGrammar(option, value, env, state)
        if (Result.isFailure(result)) {
          issues.push(result.failure)
          continue
        }
        if (node.print === "first") return result
        const issue = roundTripIssue(grammar, value, result.success, env)
        if (issue === undefined) return result
        issues.push({
          _tag: "InvalidValue",
          expected: describe(option),
          actual: value,
          detail: describeRoundTrip(issue),
        })
      }
      return fail({ _tag: "NoAlternative", actual: value, issues })
    }
    case "Dispatch": {
      if (!Predicate.isObject(value) || !Object.hasOwn(value, node.tag)) {
        return fail({ _tag: "TypeMismatch", expected: `an object with a ${node.tag} field`, actual: value })
      }
      const key = value[node.tag]
      const matchCase = caseFor(node.cases, key)
      if (matchCase === undefined) {
        const keys = node.cases.map((candidate) => preview(candidate.key)).join(", ")
        return invalid(`${node.tag} to be one of ${keys}`, key)
      }
      return printGrammar(matchCase.grammar, value, env, state)
    }
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return fail({ _tag: "MissingBinding", binding: "match selector" })
      const matchCase = caseFor(node.cases, key)
      if (matchCase === undefined) return invalid(`a match case for ${preview(key)}`, value)
      return printGrammar(matchCase.grammar, value, env, state)
    }
    case "Optional":
      return value === undefined ? Result.succeed("") : printGrammar(node.inner, value, env, state)
    case "Repeat": {
      const min = printCount(evaluate(node.min, env), "repeat count")
      if (Result.isFailure(min)) return Result.fail(min.failure)
      const max =
        node.max === undefined ? Result.succeed(Infinity) : printCount(evaluate(node.max, env), "repeat count")
      if (Result.isFailure(max)) return Result.fail(max.failure)
      if (!Array.isArray(value)) return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length < min.success || value.length > max.success) {
        const expected =
          min.success === max.success
            ? `${min.success}`
            : max.success === Infinity
              ? `at least ${min.success}`
              : `${min.success}..${max.success}`
        return invalid(`${expected} items`, value.length)
      }
      const separator = printGrammar(node.sep, undefined, env, state)
      if (Result.isFailure(separator)) return separator
      return printItems(node.inner, value, separator.success, env, state)
    }
    case "Transform": {
      try {
        const encoded = node.encode(value)
        if (Result.isFailure(encoded)) return invalid(encoded.failure, value)
        return printGrammar(node.inner, encoded.success, env, state)
      } catch (error) {
        return invalid(describe(node.inner), value, exceptionMessage(error))
      }
    }
    case "Skip":
      return printGrammar(node.inner, node.printAs, env, state)
    case "Label":
      return printGrammar(node.inner, value, env, state)
    case "Suspend": {
      const values = state.activeFor.get(node) ?? new Set<Value>()
      if (values.has(value)) {
        const where = `suspend${node.name === undefined ? "" : ` ${JSON.stringify(node.name)}`}`
        return invalid("a productive recursive grammar", value, `${where} recursed with the same value`)
      }
      let target: AnyGrammar
      try {
        target = resolve(node)
      } catch (error) {
        return invalid("a valid suspended grammar", value, exceptionMessage(error))
      }
      state.activeFor.set(node, values)
      values.add(value)
      try {
        return printGrammar(target, value, env, state)
      } finally {
        values.delete(value)
        if (values.size === 0) state.activeFor.delete(node)
      }
    }
  }
}

export const printUnchecked = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  Result.mapError(
    printGrammar(grammar, value, undefined, { activeFor: new Map() }),
    (issue) => new PrintError({ issue }),
  )

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  Result.flatMap(printUnchecked(grammar, value), (printed) => {
    const issue = roundTripIssue(grammar, value, printed, undefined)
    return issue === undefined ? Result.succeed(printed) : Result.fail(new PrintError({ issue }))
  })
