import { Equal, Predicate, Result } from "effect"

import { type AnyGrammar, type Domain, type Grammar, isCount, type Node, nodeOf, resolve, type Value } from "./core.ts"
import { caseFor, evaluate, type Frame, frame, Unbound } from "./env.ts"
import { describeRoundTrip, exceptionMessage, preview, PrintError, type PrintIssue } from "./errors.ts"
import { nonByte, toBytes } from "./internal/bytes.ts"
import { describe, describeStep } from "./internal/describe.ts"
import { atPath, catchResult, inspect } from "./internal/runtime.ts"
import { isSyntaxOnly } from "./internal/syntax.ts"
import { parseWithEnv } from "./parse.ts"
import { unifyPattern } from "./pattern.ts"

interface State {
  readonly domain: Domain
  readonly activeFor: Map<Node, Set<Value>>
}

type Printed = Result.Result<string, PrintIssue>

const fail = (issue: PrintIssue): Printed => Result.fail(issue)

const invalid = (expected: string, actual: Value, detail?: string): Printed =>
  fail({ _tag: "InvalidValue", expected, actual, detail })

const roundTripIssue = (
  grammar: AnyGrammar,
  value: Value,
  printed: string,
  env: Frame | undefined,
  domain: Domain,
): PrintIssue | undefined => {
  if (domain === "bytes" && nonByte.test(printed)) {
    return { _tag: "InvalidValue", expected: "only bytes to be printed", actual: value }
  }
  const output = domain === "bytes" ? toBytes(printed) : printed
  const back = parseWithEnv(grammar, printed, env, domain)
  if (Result.isFailure(back)) return { _tag: "RoundTrip", value, printed: output, error: back.failure.message }
  const equal = inspect(value, "round-trip equality", () => Equal.equals(back.success, value))
  if (Result.isFailure(equal)) return equal.failure
  return equal.success ? undefined : { _tag: "RoundTrip", value, printed: output, parsed: back.success }
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
  for (let index = 0; index < items.length; index++) {
    const result = Result.flatMap(
      inspect(items, "a readable array element", () => items[index]),
      (item) => printGrammar(inner, item, env, state),
    )
    if (Result.isFailure(result)) return atPath(index, result)
    text += index === 0 ? result.success : separator + result.success
  }
  return Result.succeed(text)
}

const printGrammar = (grammar: AnyGrammar, value: Value, env: Frame | undefined, state: State): Printed => {
  return catchResult(
    () => printNode(grammar, value, env, state),
    (error): PrintIssue => ({
      _tag: "InvalidValue",
      expected: describe(grammar),
      actual: value,
      detail: exceptionMessage(error),
    }),
  )
}

const printNode = (grammar: AnyGrammar, value: Value, env: Frame | undefined, state: State): Printed => {
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
        : invalid(
            `${count.success} ${state.domain === "bytes" ? "byte" : "character"}${count.success === 1 ? "" : "s"}`,
            state.domain === "bytes" ? toBytes(value) : value,
          )
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
        const issue = roundTripIssue(grammar, value, result.success, env, state.domain)
        if (issue === undefined) return result
        issues.push(
          issue._tag === "RoundTrip"
            ? {
                _tag: "InvalidValue",
                expected: describe(option),
                actual: value,
                detail: describeRoundTrip(issue),
              }
            : issue,
        )
      }
      return fail({ _tag: "NoAlternative", actual: value, issues })
    }
    case "Dispatch": {
      if (!Predicate.isObject(value)) {
        return fail({ _tag: "TypeMismatch", expected: `an object with a ${node.tag} field`, actual: value })
      }
      const tag = atPath(
        node.tag,
        inspect(value, "a readable field", () => (Object.hasOwn(value, node.tag) ? value[node.tag] : Unbound)),
      )
      if (Result.isFailure(tag)) return fail(tag.failure)
      if (tag.success === Unbound) {
        return fail({ _tag: "TypeMismatch", expected: `an object with a ${node.tag} field`, actual: value })
      }
      const key = tag.success
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
      const encoded = inspect(value, describe(node.inner), () => node.encode(value))
      if (Result.isFailure(encoded)) return fail(encoded.failure)
      if (Result.isFailure(encoded.success)) return invalid(encoded.success.failure, value)
      return printGrammar(node.inner, encoded.success.success, env, state)
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

export const printUncheckedDomain = <A, D extends Domain>(
  grammar: Grammar<A, D>,
  value: A,
  domain: Domain = "text",
): Result.Result<string, PrintError> =>
  Result.mapError(
    printGrammar(grammar, value, undefined, { domain, activeFor: new Map() }),
    (issue) => new PrintError({ issue }),
  )

export const printDomain = <A, D extends Domain>(
  grammar: Grammar<A, D>,
  value: A,
  domain: Domain = "text",
): Result.Result<string, PrintError> =>
  Result.flatMap(printUncheckedDomain(grammar, value, domain), (printed) => {
    const issue = roundTripIssue(grammar, value, printed, undefined, domain)
    return issue === undefined ? Result.succeed(printed) : Result.fail(new PrintError({ issue }))
  })

export const print: <A>(grammar: Grammar<A, "text">, value: A) => Result.Result<string, PrintError> = printDomain
export const printUnchecked: <A>(grammar: Grammar<A, "text">, value: A) => Result.Result<string, PrintError> =
  printUncheckedDomain
