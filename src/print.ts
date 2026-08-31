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
import { caseFor, evaluate, type Frame, frame, isCount, Unbound } from "./env.ts"
import { exceptionMessage, preview, PrintError, type PrintIssue } from "./errors.ts"
import { reparse } from "./parse.ts"
import { unifyPattern } from "./pattern.ts"
import { describe, describeStep } from "./render.ts"

class Failure {
  readonly issue: PrintIssue

  constructor(issue: PrintIssue) {
    this.issue = issue
  }
}

const fail = (issue: PrintIssue): Failure => new Failure(issue)

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

const issueAt = (issue: PrintIssue, path: ReadonlyArray<string | number>): PrintIssue => {
  let nested = issue
  for (let index = path.length - 1; index >= 0; index--) {
    nested = { _tag: "AtPath", path: path[index]!, issue: nested }
  }
  return nested
}

const outputGen = (
  node: Extract<Node, { _tag: "Gen" }>,
  value: Value,
  env: Frame | undefined,
): string | Failure => {
  const local = frame(node.scope, node.slotCount, env)
  const issue = unifyPattern(node.result, value, local)
  if (issue !== undefined) return fail(issue)

  let text = ""
  for (const [index, step] of node.steps.entries()) {
    const result =
      step._tag === "Silent"
        ? out(step.grammar, undefined, local)
        : local.values[step.slot] === Unbound
          ? fail({ _tag: "MissingBinding", binding: describeStep(step, index) })
          : out(step.grammar, local.values[step.slot], local)
    if (result instanceof Failure) {
      const path =
        step._tag === "Bind" ? bindingPath(node.result, node.scope, step.slot, []) : undefined
      return fail(path === undefined ? result.issue : issueAt(result.issue, path))
    }
    text += result
  }
  return text
}

const out = (grammar: GrammarInternal, value: Value, env: Frame | undefined): string | Failure => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value
    case "Regex": {
      if (!Predicate.isString(value))
        return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      node.re.lastIndex = 0
      const match = node.re.exec(value)
      if (match === null || match.index !== 0 || match[0].length !== value.length) {
        return fail({
          _tag: "InvalidValue",
          expected: node.name,
          actual: value,
          detail: `${JSON.stringify(value)} does not match /${node.re.source}/`,
        })
      }
      return value
    }
    case "Gen":
      return outputGen(node, value, env)
    case "Wrap": {
      const open = out(node.open, undefined, env)
      if (open instanceof Failure) return open
      const inner = out(node.inner, value, env)
      if (inner instanceof Failure) return inner
      const close = out(node.close, undefined, env)
      return close instanceof Failure ? close : open + inner + close
    }
    case "Choice": {
      if (node.on !== undefined) {
        const { tag, keys } = node.on
        if (!Predicate.isObject(value) || !Object.hasOwn(value, tag)) {
          return fail({
            _tag: "TypeMismatch",
            expected: `an object with a ${tag} field`,
            actual: value,
          })
        }
        const key = value[tag]
        const index = keys.findIndex((candidate) => Object.is(candidate, key))
        if (index === -1) {
          return fail({
            _tag: "InvalidValue",
            expected: `${tag} to be one of ${keys.map(preview).join(", ")}`,
            actual: key,
          })
        }
        return out(node.options[index]!, value, env)
      }
      const roundTrip = node.printSelection === "roundTrip"
      const issues: Array<PrintIssue> = []
      for (const option of node.options) {
        const result = out(option, value, env)
        if (result instanceof Failure) {
          issues.push(result.issue)
          continue
        }
        if (!roundTrip) return result
        const back = reparse(grammar, result, env)
        if (back.ok && Equal.equals(back.value, value)) return result
        issues.push({
          _tag: "InvalidValue",
          expected: describe(option),
          actual: value,
          detail: back.ok
            ? `prints as ${JSON.stringify(result)}, which reads back as ${preview(back.value)}`
            : `prints as ${JSON.stringify(result)}, which does not parse: ${back.error.message}`,
        })
      }
      return fail({ _tag: "NoAlternative", actual: value, issues })
    }
    case "Many": {
      if (!Array.isArray(value))
        return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length < node.min || value.length > node.max) {
        const expected =
          node.max === Number.POSITIVE_INFINITY
            ? `at least ${node.min}`
            : `${node.min}..${node.max}`
        return fail({
          _tag: "InvalidValue",
          expected: `${expected} items`,
          actual: value,
          detail: `expected ${expected} items, got ${value.length}`,
        })
      }
      const separator = out(node.sep, undefined, env)
      if (separator instanceof Failure) return separator
      let text = ""
      for (const [index, item] of value.entries()) {
        const result = out(node.inner, item, env)
        if (result instanceof Failure) {
          return fail({ _tag: "AtPath", path: index, issue: result.issue })
        }
        text += index === 0 ? result : separator + result
      }
      return text
    }
    case "Optional":
      return value === undefined ? "" : out(node.inner, value, env)
    case "Transform": {
      try {
        if (node.is?.(unsafeToNever(value)) === false) {
          return fail({
            _tag: "InvalidValue",
            expected: node.name ?? describe(node.inner),
            actual: value,
          })
        }
        const encoded = node.encode(unsafeToNever(value))
        return Result.isFailure(encoded)
          ? fail({
              _tag: "InvalidValue",
              expected: node.name ?? describe(node.inner),
              actual: value,
              detail: encoded.failure.message,
            })
          : out(node.inner, encoded.success, env)
      } catch (error) {
        return fail({
          _tag: "InvalidValue",
          expected: node.name ?? describe(node.inner),
          actual: value,
          detail: exceptionMessage(error),
        })
      }
    }
    case "Skip":
      return out(node.inner, node.printAs, env)
    case "Label":
      return out(node.inner, value, env)
    case "Suspend":
      return out(resolve(node), value, env)
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return fail({ _tag: "MissingBinding", binding: "match selector" })
      const matchCase = caseFor(node.cases, key)
      return matchCase === undefined
        ? fail({
            _tag: "InvalidValue",
            expected: `a match case for ${preview(key)}`,
            actual: value,
          })
        : out(matchCase.grammar, value, env)
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return fail({ _tag: "MissingBinding", binding: "take count" })
      if (!isCount(count)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
      }
      if (!Predicate.isString(value))
        return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      return value.length === count
        ? value
        : fail({
            _tag: "InvalidValue",
            expected: `${count} UTF-16 code units`,
            actual: value,
          })
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return fail({ _tag: "MissingBinding", binding: "repeat count" })
      if (!isCount(count)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
      }
      if (!Array.isArray(value))
        return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== count) {
        return fail({
          _tag: "InvalidValue",
          expected: `${count} items`,
          actual: value.length,
        })
      }
      let text = ""
      for (const [index, item] of value.entries()) {
        const result = out(node.inner, item, env)
        if (result instanceof Failure) {
          return fail({ _tag: "AtPath", path: index, issue: result.issue })
        }
        text += result
      }
      return text
    }
  }
}

export const printUnknown = (
  grammar: GrammarInternal,
  value: Value,
): Result.Result<string, PrintError> => {
  const result = out(grammar, value, undefined)
  return result instanceof Failure
    ? Result.fail(new PrintError({ issue: result.issue }))
    : Result.succeed(result)
}

/** Write a value as canonical text. No round-trip guarantee; see {@link printCheckedUnknown}. */
export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  printUnknown(grammar, value)

export const printCheckedUnknown = (
  grammar: GrammarInternal,
  value: Value,
): Result.Result<string, PrintError> => {
  const printed = printUnknown(grammar, value)
  if (Result.isFailure(printed)) return printed
  const back = reparse(grammar, printed.success, undefined)
  if (!back.ok) {
    return Result.fail(
      new PrintError({
        issue: { _tag: "RoundTrip", value, printed: printed.success, error: back.error.message },
      }),
    )
  }
  if (!Equal.equals(back.value, value)) {
    return Result.fail(
      new PrintError({
        issue: { _tag: "RoundTrip", value, printed: printed.success, parsed: back.value },
      }),
    )
  }
  return printed
}

/**
 * Print a value, then parse the whole output back and confirm it equals the
 * original. Fails if the text would decode to a different value, so a checked
 * print never hides a broken round trip.
 */
export const printChecked = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  printCheckedUnknown(grammar, value)
