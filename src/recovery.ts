import { Equal, Option, Predicate, Result } from "effect"

import {
  type Expr,
  type GrammarInternal,
  nodeOf,
  type Node,
  type Pattern,
  type RefExpr,
  type ScopeId,
  type Value,
} from "./core.ts"
import { bind, cloneFrame, evaluate, frame, type Frame, localValue } from "./env.ts"
import { unifyPattern } from "./pattern.ts"

export interface Assignment {
  readonly ref: RefExpr
  readonly value: Value
}

export type RecoveryPlan = ReadonlyArray<Assignment>

const unsafeToNever = (value: Value): never => {
  // SAFETY: erased Node callbacks accept the runtime value produced for that node.
  return value as never
}

const sameRef = (left: RefExpr, right: RefExpr) =>
  left.scope === right.scope && left.slot === right.slot

const addRef = (refs: Array<RefExpr>, ref: RefExpr): void => {
  if (!refs.some((candidate) => sameRef(candidate, ref))) refs.push(ref)
}

const collectPatternRefs = (pattern: Pattern, scope: ScopeId, slots: Set<number>): void => {
  switch (pattern._tag) {
    case "Ref":
      if (pattern.scope === scope) slots.add(pattern.slot)
      return
    case "Const":
      return
    case "Object":
      for (const [, field] of pattern.fields) collectPatternRefs(field, scope, slots)
      return
    case "Array":
      for (const item of pattern.items) collectPatternRefs(item, scope, slots)
  }
}

const analyze = (grammar: GrammarInternal, seen: Set<Node>): ReadonlyArray<RefExpr> => {
  const node = nodeOf(grammar)
  if (seen.has(node)) return []
  seen.add(node)
  const refs: Array<RefExpr> = []

  switch (node._tag) {
    case "Wrap":
    case "Label":
    case "Transform":
    case "TransformOrFail":
      for (const ref of analyze(node.inner, seen)) addRef(refs, ref)
      break
    case "Match":
      if (node.scrutinee._tag === "Ref") addRef(refs, node.scrutinee)
      break
    case "Dependent":
      if (node.recover !== undefined) {
        for (const dep of node.deps) if (dep._tag === "Ref") addRef(refs, dep)
      }
      break
    case "Take":
    case "RepeatExact":
      if (node.count._tag === "Ref") addRef(refs, node.count)
      break
    case "Gen": {
      const known = new Set<number>()
      collectPatternRefs(node.result, node.scope, known)
      for (let index = node.steps.length - 1; index >= 0; index--) {
        const step = node.steps[index]
        if (step?._tag !== "Bind" || !known.has(step.slot)) continue
        for (const ref of analyze(step.grammar, seen)) {
          if (ref.scope === node.scope) known.add(ref.slot)
          else addRef(refs, ref)
        }
      }
      break
    }
    case "Suspend":
      if (node.resolved !== undefined) {
        for (const ref of analyze(node.resolved, seen)) addRef(refs, ref)
      }
      break
    case "Literal":
    case "Regex":
    case "Choice":
    case "Many":
    case "Optional":
    case "Skip":
      break
  }

  seen.delete(node)
  return refs
}

export const recoverableRefs = (grammar: GrammarInternal): ReadonlyArray<RefExpr> =>
  analyze(grammar, new Set())

const assignmentFor = (
  ref: RefExpr,
  value: Value,
  env: Frame | undefined,
): RecoveryPlan | undefined => {
  const current = evaluate(ref, env)
  if (Option.isSome(current)) return Equal.equals(current.value, value) ? [] : undefined
  return [{ ref, value }]
}

const mergePlans = (left: RecoveryPlan, right: RecoveryPlan): RecoveryPlan | undefined => {
  const merged = [...left]
  for (const assignment of right) {
    const current = merged.find((candidate) => sameRef(candidate.ref, assignment.ref))
    if (current !== undefined) {
      if (!Equal.equals(current.value, assignment.value)) return undefined
      continue
    }
    merged.push(assignment)
  }
  return merged
}

const evaluateWithPlan = (
  expr: Expr,
  env: Frame | undefined,
  plan: RecoveryPlan,
): Option.Option<Value> => {
  if (expr._tag === "Ref") {
    const assignment = plan.find((candidate) => sameRef(candidate.ref, expr))
    return assignment === undefined ? evaluate(expr, env) : Option.some(assignment.value)
  }

  const object = evaluateWithPlan(expr.object, env, plan)
  if (Option.isNone(object) || object.value === null || object.value === undefined) {
    return Option.none()
  }
  const boxed = Object(object.value)
  return Object.hasOwn(boxed, expr.key) ? Option.some(boxed[expr.key]) : Option.none()
}

interface GenState {
  readonly local: Frame
  readonly external: RecoveryPlan
}

const applyAssignments = (state: GenState, assignments: RecoveryPlan): GenState | undefined => {
  const local = cloneFrame(state.local)
  let external = state.external

  for (const assignment of assignments) {
    if (assignment.ref.scope === local.scope) {
      const current = localValue(local, assignment.ref.slot)
      if (Option.isSome(current) && !Equal.equals(current.value, assignment.value)) return undefined
      bind(local, assignment.ref.slot, assignment.value)
      continue
    }

    const merged = mergePlans(external, [assignment])
    if (merged === undefined) return undefined
    external = merged
  }

  return { local, external }
}

const recoverGen = (
  node: Extract<Node, { _tag: "Gen" }>,
  value: Value,
  env: Frame | undefined,
): ReadonlyArray<RecoveryPlan> => {
  const initial = frame(node.scope, node.slotCount, env)
  if (unifyPattern(node.result, value, initial) !== undefined) return []

  let states: ReadonlyArray<GenState> = [{ local: initial, external: [] }]
  for (let index = node.steps.length - 1; index >= 0; index--) {
    const step = node.steps[index]
    if (step?._tag !== "Bind") continue

    const next: Array<GenState> = []
    for (const state of states) {
      const bound = localValue(state.local, step.slot)
      if (Option.isNone(bound)) continue
      for (const plan of recoverPlans(step.grammar, bound.value, state.local)) {
        const applied = applyAssignments(state, plan)
        if (applied !== undefined) next.push(applied)
      }
    }
    states = next
  }

  return states.map((state) => state.external)
}

const recoverDependent = (
  node: Extract<Node, { _tag: "Dependent" }>,
  value: Value,
  env: Frame | undefined,
): ReadonlyArray<RecoveryPlan> => {
  if (node.recover === undefined) return [[]]

  let recovered: ReadonlyArray<Value> | undefined
  try {
    recovered = node.recover(unsafeToNever(value))
  } catch {
    return []
  }
  if (recovered === undefined) return []

  let plan: RecoveryPlan = []
  for (const [index, dep] of node.deps.entries()) {
    const recoveredValue = recovered[index]
    if (index >= recovered.length) break
    if (dep._tag !== "Ref") {
      const current = evaluate(dep, env)
      if (Option.isNone(current) || !Equal.equals(current.value, recoveredValue)) return []
      continue
    }
    const assignment = assignmentFor(dep, recoveredValue, env)
    if (assignment === undefined) return []
    const merged = mergePlans(plan, assignment)
    if (merged === undefined) return []
    plan = merged
  }

  const values = node.deps.map((dep) => evaluateWithPlan(dep, env, plan))
  if (values.some(Option.isNone)) return [plan]

  let selected: GrammarInternal | undefined
  try {
    selected = node.select(values.map((item) => unsafeToNever(Option.getOrThrow(item))))
  } catch {
    return []
  }
  if (selected === undefined) return [plan]

  const out: Array<RecoveryPlan> = []
  for (const child of recoverPlans(selected, value, env)) {
    const merged = mergePlans(plan, child)
    if (merged !== undefined) out.push(merged)
  }
  return out.length === 0 ? [plan] : out
}

export const recoverPlans = (
  grammar: GrammarInternal,
  value: Value,
  env: Frame | undefined,
): ReadonlyArray<RecoveryPlan> => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Regex":
    case "Skip":
    case "Many":
    case "Optional":
      return [[]]
    case "Wrap":
    case "Label":
      return recoverPlans(node.inner, value, env)
    case "Choice":
      return node.options.flatMap((option) => recoverPlans(option, value, env))
    case "Transform": {
      try {
        if (node.is?.(unsafeToNever(value)) === false) return []
        return recoverPlans(node.inner, node.encode(unsafeToNever(value)), env)
      } catch {
        return []
      }
    }
    case "TransformOrFail": {
      try {
        if (node.is?.(unsafeToNever(value)) === false) return []
        const encoded = node.encode(unsafeToNever(value))
        return Result.isFailure(encoded) ? [] : recoverPlans(node.inner, encoded.success, env)
      } catch {
        return []
      }
    }
    case "Match": {
      const current = evaluate(node.scrutinee, env)
      const cases = Option.isSome(current)
        ? node.cases.filter((matchCase) => Object.is(matchCase.key, current.value))
        : node.cases
      const out: Array<RecoveryPlan> = []
      for (const matchCase of cases) {
        const selector =
          node.scrutinee._tag === "Ref"
            ? assignmentFor(node.scrutinee, matchCase.key, env)
            : Option.isSome(current) && Object.is(current.value, matchCase.key)
              ? []
              : undefined
        if (selector === undefined) continue
        for (const child of recoverPlans(matchCase.grammar, value, env)) {
          const merged = mergePlans(selector, child)
          if (merged !== undefined) out.push(merged)
        }
      }
      return out
    }
    case "Dependent":
      return recoverDependent(node, value, env)
    case "Take": {
      if (node.count._tag !== "Ref" || !Predicate.isString(value)) return [[]]
      const assignment = assignmentFor(node.count, value.length, env)
      return assignment === undefined ? [] : [assignment]
    }
    case "RepeatExact": {
      if (node.count._tag !== "Ref" || !Array.isArray(value)) return [[]]
      const assignment = assignmentFor(node.count, value.length, env)
      return assignment === undefined ? [] : [assignment]
    }
    case "Gen":
      return recoverGen(node, value, env)
    case "Suspend":
      return node.resolved === undefined ? [[]] : recoverPlans(node.resolved, value, env)
  }
}
