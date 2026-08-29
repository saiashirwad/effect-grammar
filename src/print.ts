import { Equal, Option, Predicate, Result } from "effect"

import {
  assertClosed,
  freeScopesOf,
  type Grammar,
  type GrammarInternal,
  nodeOf,
  type Node,
  type Pattern,
  resolve,
  type ScopeId,
  type Step,
  type Value,
} from "./core.ts"
import {
  caseFor,
  cloneFrame,
  evaluate,
  frame,
  type Frame,
  isCount,
  localValue,
  bind,
} from "./env.ts"
import { exceptionMessage, preview, PrintError, type PrintIssue } from "./errors.ts"
import { unifyPattern } from "./pattern.ts"
import { recoverPlans, type RecoveryPlan } from "./recovery.ts"
import { describe, describeStep, renderInternal } from "./render.ts"

class Failure {
  readonly issue: PrintIssue

  constructor(issue: PrintIssue) {
    this.issue = issue
  }
}

const unsafeToNever = (value: Value): never => {
  // SAFETY: erased Node callbacks accept the runtime value produced for that node.
  return value as never
}

const fail = (issue: PrintIssue): Failure => new Failure(issue)

const hasScope = (env: Frame | undefined, scope: ScopeId): boolean => {
  for (let current = env; current !== undefined; current = current.parent) {
    if (current.scope === scope) return true
  }
  return false
}

const refsAvailable = (grammar: GrammarInternal, env: Frame | undefined): boolean => {
  for (const scope of freeScopesOf(grammar)) if (!hasScope(env, scope)) return false
  return true
}

const applyLocalPlan = (source: Frame, plan: RecoveryPlan): Frame | undefined => {
  const local = cloneFrame(source)
  for (const assignment of plan) {
    if (assignment.ref.scope === local.scope) {
      const current = localValue(local, assignment.ref.slot)
      if (Option.isSome(current) && !Equal.equals(current.value, assignment.value)) return undefined
      bind(local, assignment.ref.slot, assignment.value)
      continue
    }

    const current = evaluate(assignment.ref, local)
    if (Option.isNone(current) || !Equal.equals(current.value, assignment.value)) return undefined
  }
  return local
}

const completeFrames = (
  node: Extract<Node, { _tag: "Gen" }>,
  initial: Frame,
): ReadonlyArray<Frame> => {
  let states: ReadonlyArray<Frame> = [initial]
  for (let index = node.steps.length - 1; index >= 0; index--) {
    const step = node.steps[index]
    if (step?._tag !== "Bind") continue

    const next: Array<Frame> = []
    for (const state of states) {
      const value = localValue(state, step.slot)
      if (Option.isNone(value)) continue
      next.push(state)
      for (const plan of recoverPlans(step.grammar, value.value, state)) {
        const recoversUnbound = plan.some(
          (assignment) =>
            assignment.ref.scope === state.scope &&
            Option.isNone(localValue(state, assignment.ref.slot)),
        )
        if (!recoversUnbound) continue
        const applied = applyLocalPlan(state, plan)
        if (applied !== undefined) next.push(applied)
      }
    }
    states = next
  }
  return states
}

const firstMissing = (steps: ReadonlyArray<Step>, local: Frame): PrintIssue => {
  for (const [index, step] of steps.entries()) {
    if (step._tag === "Bind" && Option.isNone(localValue(local, step.slot))) {
      return { _tag: "MissingBinding", binding: describeStep(step, index) }
    }
  }
  return { _tag: "MissingBinding", binding: "a generator binding" }
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
  const initial = frame(node.scope, node.slotCount, env)
  const issue = unifyPattern(node.result, value, initial)
  if (issue !== undefined) return fail(issue)

  const complete = completeFrames(node, initial)
  if (complete.length === 0) return fail(firstMissing(node.steps, initial))

  const failures: Array<PrintIssue> = []
  for (const local of complete) {
    let text = ""
    let rejected: PrintIssue | undefined
    for (const step of node.steps) {
      const result =
        step._tag === "Silent"
          ? out(step.grammar, undefined, local)
          : Option.match(localValue(local, step.slot), {
              onNone: () => fail(firstMissing([step], local)),
              onSome: (bound) => out(step.grammar, bound, local),
            })
      if (result instanceof Failure) {
        const path =
          step._tag === "Bind" ? bindingPath(node.result, node.scope, step.slot, []) : undefined
        rejected = path === undefined ? result.issue : issueAt(result.issue, path)
        break
      }
      text += result
    }
    if (rejected === undefined) return text
    failures.push(rejected)
  }

  return fail(
    failures.length === 1
      ? failures[0]!
      : { _tag: "NoAlternative", actual: value, issues: failures },
  )
}

const out = (grammar: GrammarInternal, value: Value, env: Frame | undefined): string | Failure => {
  if (!refsAvailable(grammar, env)) {
    return fail({ _tag: "MissingBinding", binding: "a grammar ref" })
  }

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
      const issues: Array<PrintIssue> = []
      for (const option of node.options) {
        const result = out(option, value, env)
        if (!(result instanceof Failure)) return result
        issues.push(result.issue)
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
        return out(node.inner, node.encode(unsafeToNever(value)), env)
      } catch (error) {
        return fail({
          _tag: "InvalidValue",
          expected: node.name ?? describe(node.inner),
          actual: value,
          detail: exceptionMessage(error),
        })
      }
    }
    case "TransformOrFail": {
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
      if (Option.isNone(key)) return fail({ _tag: "MissingBinding", binding: "match selector" })
      const matchCase = caseFor(node.cases, key.value)
      return matchCase === undefined
        ? fail({
            _tag: "InvalidValue",
            expected: `a match case for ${preview(key.value)}`,
            actual: value,
          })
        : out(matchCase.grammar, value, env)
    }
    case "Dependent": {
      const values = Option.all(node.deps.map((dep) => evaluate(dep, env)))
      if (Option.isNone(values)) {
        return fail({ _tag: "MissingBinding", binding: "a dependent grammar ref" })
      }
      try {
        const chosen = node.select(values.value.map(unsafeToNever))
        return chosen === undefined
          ? fail({
              _tag: "InvalidValue",
              expected: node.show(values.value.map(preview), renderInternal),
              actual: value,
            })
          : out(chosen, value, env)
      } catch (error) {
        return fail({
          _tag: "InvalidValue",
          expected: "dependent",
          actual: value,
          detail: exceptionMessage(error),
        })
      }
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (Option.isNone(count)) return fail({ _tag: "MissingBinding", binding: "take count" })
      if (!isCount(count.value)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count.value })
      }
      if (!Predicate.isString(value))
        return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      return value.length === count.value
        ? value
        : fail({
            _tag: "InvalidValue",
            expected: `${count.value} UTF-16 code units`,
            actual: value,
          })
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (Option.isNone(count)) return fail({ _tag: "MissingBinding", binding: "repeat count" })
      if (!isCount(count.value)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count.value })
      }
      if (!Array.isArray(value))
        return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== count.value) {
        return fail({
          _tag: "InvalidValue",
          expected: `${count.value} items`,
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
  assertClosed(grammar, "print")
  const result = out(grammar, value, undefined)
  return result instanceof Failure
    ? Result.fail(new PrintError({ issue: result.issue }))
    : Result.succeed(result)
}

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  printUnknown(grammar, value)
