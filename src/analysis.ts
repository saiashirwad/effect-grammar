import { type AnyGrammar, type Expr, type Node, nodeOf, resolve, type ScopeId } from "./core.ts"
import { exceptionMessage } from "./errors.ts"
import { describe, describeStep } from "./internal/describe.ts"
import { isSyntaxOnly } from "./internal/syntax.ts"

export interface GrammarIssue {
  readonly _tag: "OutOfScopeRef" | "EmptyRepetition" | "OmittedValue" | "InvalidSuspend"
  /** Graph edges from the root, with zero-based step, option, and case indices. */
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

interface Edge {
  readonly path: ReadonlyArray<string | number>
  readonly grammar: AnyGrammar
}

// Suspensions have a separate resolution boundary so failed thunks remain diagnosable.
const children = (node: Exclude<Node, { readonly _tag: "Suspend" }>): ReadonlyArray<Edge> => {
  switch (node._tag) {
    case "Literal":
    case "Regex":
    case "Take":
      return []
    case "Gen":
      return node.steps.map((grammar, index) => ({ path: ["steps", index], grammar }))
    case "Choice":
      return node.options.map((grammar, index) => ({ path: ["options", index], grammar }))
    case "Dispatch":
    case "Match":
      return node.cases.map(({ grammar }, index) => ({ path: ["cases", index, "grammar"], grammar }))
    case "Repeat":
      return [
        { path: ["inner"], grammar: node.inner },
        { path: ["sep"], grammar: node.sep },
      ]
    case "Optional":
    case "Transform":
    case "Skip":
    case "Label":
      return [{ path: ["inner"], grammar: node.inner }]
  }
}

type Suspension = Extract<Node, { readonly _tag: "Suspend" }>
type Resolution =
  | { readonly _tag: "Resolved"; readonly grammar: AnyGrammar }
  | { readonly _tag: "Failed"; readonly message: string }
type Resolutions = WeakMap<Suspension, Resolution>

// Queries and the walk share failures as well as successes. The walk reports failures
// at their graph paths, even if a query short-circuits before reaching that suspension.
const inspect = (node: Suspension, resolutions: Resolutions): Resolution => {
  const cached = resolutions.get(node)
  if (cached !== undefined) return cached
  let result: Resolution
  try {
    result = { _tag: "Resolved", grammar: resolve(node) }
  } catch (error) {
    result = { _tag: "Failed", message: exceptionMessage(error) }
  }
  resolutions.set(node, result)
  return result
}

type EmptyMatch = "yes" | "no" | "unknown"

const allMatchEmpty = (grammars: Iterable<AnyGrammar>, seen: Set<Node>, resolutions: Resolutions): EmptyMatch => {
  let result: EmptyMatch = "yes"
  for (const grammar of grammars) {
    const match = matchesEmpty(grammar, seen, resolutions)
    if (match === "no") return "no"
    if (match === "unknown") result = "unknown"
  }
  return result
}

const matchesEmpty = (grammar: AnyGrammar, seen: Set<Node>, resolutions: Resolutions): EmptyMatch => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value === "" ? "yes" : "no"
    case "Regex":
      return new RegExp(node.source, `${node.flags}y`).exec("") === null ? "no" : "yes"
    case "Take":
      if (node.count._tag !== "Const") return "unknown"
      return node.count.value === 0 ? "yes" : "no"
    case "Gen":
      return allMatchEmpty(node.steps, seen, resolutions)
    case "Choice":
    case "Dispatch": {
      let result: EmptyMatch = "no"
      for (const { grammar } of children(node)) {
        const match = matchesEmpty(grammar, seen, resolutions)
        if (match === "yes") return "yes"
        if (match === "unknown") result = "unknown"
      }
      return result
    }
    case "Match":
      return "unknown"
    case "Optional":
      return "yes"
    case "Repeat": {
      if (node.min._tag !== "Const" || (node.max !== undefined && node.max._tag !== "Const")) return "unknown"
      if (node.max?.value === 0) return "yes"
      const item = matchesEmpty(node.inner, seen, resolutions)
      if (item === "yes") return "no"
      if (item === "unknown") return "unknown"
      return node.min.value === 0 ? "yes" : "no"
    }
    case "Transform": {
      const inner = matchesEmpty(node.inner, seen, resolutions)
      return inner === "yes" ? "unknown" : inner
    }
    case "Label":
    case "Skip":
      return matchesEmpty(node.inner, seen, resolutions)
    case "Suspend": {
      if (seen.has(node)) return "unknown"
      const target = inspect(node, resolutions)
      if (target._tag === "Failed") return "unknown"
      seen.add(node)
      const empty = matchesEmpty(target.grammar, seen, resolutions)
      seen.delete(node)
      return empty
    }
  }
}

type ScopePath = ReadonlyArray<ScopeId>

const exprScope = (expr: Expr): ScopeId | undefined =>
  expr._tag === "Ref" ? expr.scope : expr._tag === "Prop" ? exprScope(expr.object) : undefined

const sameScopePath = (left: ScopePath, right: ScopePath): boolean =>
  left.length === right.length && left.every((scope, index) => scope === right[index])

interface Walk {
  readonly issues: Array<GrammarIssue>
  readonly visiting: Set<Node>
  readonly walkedUnder: WeakMap<Node, Array<ScopePath>>
  readonly resolutions: Resolutions
}

const walk = (grammar: AnyGrammar, active: ScopePath, path: GrammarIssue["path"], state: Walk): void => {
  const node = nodeOf(grammar)

  const checkRef = (expr: Expr, field: string, where: string): void => {
    const scope = exprScope(expr)
    if (scope !== undefined && !active.includes(scope)) {
      state.issues.push({
        _tag: "OutOfScopeRef",
        path: [...path, field],
        message: `${where}: uses a ref bound by a gen that is not an ancestor here; a ref works only inside the gen that bound it`,
      })
    }
  }

  const checkProgress = (inner: AnyGrammar, repetition: string): void => {
    if (matchesEmpty(inner, new Set(), state.resolutions) === "yes") {
      state.issues.push({
        _tag: "EmptyRepetition",
        path: [...path, "inner"],
        message: `${repetition} of ${describe(inner)}, which can match the empty string, so parsing and printing would disagree about zero-width elements`,
      })
    }
  }

  if (node._tag === "Suspend") {
    if (state.visiting.has(node)) return
    const paths = state.walkedUnder.get(node)
    if (paths?.some((previous) => sameScopePath(previous, active))) return
    const target = inspect(node, state.resolutions)
    if (target._tag === "Failed") {
      state.issues.push({ _tag: "InvalidSuspend", path, message: `invalid suspend: ${target.message}` })
    } else {
      state.visiting.add(node)
      try {
        walk(target.grammar, active, [...path, "resolved"], state)
      } finally {
        state.visiting.delete(node)
      }
    }
    if (paths === undefined) state.walkedUnder.set(node, [active])
    else paths.push(active)
    return
  }

  switch (node._tag) {
    case "Gen":
      for (const [slot, step] of node.steps.entries()) {
        const omitted = !node.result.bindings.has(slot)
        if (
          omitted &&
          !isSyntaxOnly(step, (suspension) => {
            const target = inspect(suspension, state.resolutions)
            return target._tag === "Resolved" ? target.grammar : undefined
          })
        ) {
          state.issues.push({
            _tag: "OmittedValue",
            path: [...path, "steps", slot],
            message: `gen: ${describeStep(step, slot)} is parsed but not returned; return it, or discard it with skip`,
          })
        }
      }
      break
    case "Repeat":
      checkRef(node.min, "min", "repeat")
      if (node.max !== undefined) checkRef(node.max, "max", "repeat")
      if (node.max === undefined || node.max._tag !== "Const" || node.max.value > 0) {
        checkProgress(node.inner, node.max === undefined ? "unbounded repetition" : "repetition")
      }
      break
    case "Match":
      checkRef(node.scrutinee, "scrutinee", "match")
      break
    case "Take":
      checkRef(node.count, "count", "take")
      break
  }
  const scopes = node._tag === "Gen" ? [...active, node.scope] : active
  for (const edge of children(node)) walk(edge.grammar, scopes, [...path, ...edge.path], state)
}

/**
 * Inspect structural problems without running encode, decode, or predicate callbacks.
 * Suspensions resolve for graph inspection; thunk failures become InvalidSuspend issues.
 * Omitted gen steps must be provably syntax/discard-only. Optional, choice, and match
 * require syntax-only children. A gen must have syntax-only steps and return constant
 * undefined or a whole ref to one of its steps. Recursive or opaque outputs require
 * a returned ref or explicit skip.
 * Empty-match checks leave dependent and opaque cases to runtime progress checks.
 * An empty issue list does not prove that parsing or printing succeeds for every value.
 */
export const diagnose = (grammar: AnyGrammar): ReadonlyArray<GrammarIssue> => {
  const state: Walk = { issues: [], visiting: new Set(), walkedUnder: new WeakMap(), resolutions: new WeakMap() }
  walk(grammar, [], [], state)
  return state.issues
}
