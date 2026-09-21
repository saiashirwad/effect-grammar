import type { Expr, Fidelity, GrammarInternal, GrammarIssue, Node, ScopeId } from "./core.ts"
import { children, nodeOf, resolve } from "./core.ts"
import { exceptionMessage } from "./errors.ts"
import { describe } from "./render.ts"

const exprScope = (expr: Expr): ScopeId | undefined => {
  switch (expr._tag) {
    case "Ref":
      return expr.scope
    case "Prop":
      return exprScope(expr.object)
    case "Count":
      return undefined
  }
}

type EmptyMatch = "yes" | "no" | "unknown"

const allMatchEmpty = (grammars: Iterable<GrammarInternal>, seen: Set<Node>): EmptyMatch => {
  let result: EmptyMatch = "yes"
  for (const grammar of grammars) {
    const match = matchesEmpty(grammar, seen)
    if (match === "no") return "no"
    if (match === "unknown") result = "unknown"
  }
  return result
}

const matchesEmpty = (grammar: GrammarInternal, seen: Set<Node>): EmptyMatch => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value === "" ? "yes" : "no"
    case "Regex":
      return new RegExp(node.source, `${node.flags}y`).exec("") === null ? "no" : "yes"
    case "Gen":
      return allMatchEmpty(
        node.steps.map((step) => step.grammar),
        seen,
      )
    case "Wrap":
      return allMatchEmpty([node.open, node.inner, node.close], seen)
    case "Choice": {
      let result: EmptyMatch = "no"
      for (const option of node.options) {
        const match = matchesEmpty(option, new Set(seen))
        if (match === "yes") return "yes"
        if (match === "unknown") result = "unknown"
      }
      return result
    }
    case "Many": {
      if (node.max === 0) return "yes"
      const item = matchesEmpty(node.inner, seen)
      // A zero-width item makes the repetition fail its own progress guard.
      if (item === "yes") return "no"
      if (item === "unknown") return "unknown"
      return node.min === 0 ? "yes" : "no"
    }
    case "Optional":
      return "yes"
    case "Transform": {
      // Decoding may reject an empty match unless the transform is total.
      const inner = matchesEmpty(node.inner, seen)
      return inner === "yes" && node.total !== true ? "unknown" : inner
    }
    case "Label":
    case "Skip":
      return matchesEmpty(node.inner, seen)
    case "Suspend": {
      if (seen.has(node)) return "unknown"
      seen.add(node)
      const empty = matchesEmpty(resolve(node), seen)
      seen.delete(node)
      return empty
    }
    case "Take":
    case "RepeatExact":
      // Repeated items must consume input, so only a zero count matches empty.
      if (node.count._tag !== "Count") return "unknown"
      return node.count.value === 0 ? "yes" : "no"
    case "Merge":
      return allMatchEmpty(
        node.parts.map((part) => part.grammar),
        seen,
      )
    case "Match":
      return "unknown"
  }
}

// Visit reachable nodes, deduplicating only suspensions.
const eachNode = (grammar: GrammarInternal, visit: (node: Node) => void, seen: Set<Node>): void => {
  const node = nodeOf(grammar)
  if (node._tag === "Suspend") {
    if (seen.has(node)) return
    seen.add(node)
  }
  visit(node)
  for (const child of children(node)) eachNode(child, visit, seen)
}

const checkRef = (
  expr: Expr,
  where: string,
  active: ReadonlyArray<ScopeId>,
  issues: Array<GrammarIssue>,
): void => {
  const scope = exprScope(expr)
  if (scope !== undefined && !active.includes(scope)) {
    issues.push({
      message: `${where}: uses a ref bound by a gen that is not an ancestor here; a ref works only inside the gen that bound it`,
    })
  }
}

const checkProgress = (
  inner: GrammarInternal,
  repetition: string,
  issues: Array<GrammarIssue>,
): void => {
  if (matchesEmpty(inner, new Set()) === "yes") {
    issues.push({
      message: `${repetition} of ${describe(inner)}, which can match the empty string, so parsing and printing would disagree about zero-width elements`,
    })
  }
}

const sameScopePath = (left: ReadonlyArray<ScopeId>, right: ReadonlyArray<ScopeId>): boolean =>
  left.length === right.length && left.every((scope, index) => scope === right[index])

const walk = (
  grammar: GrammarInternal,
  active: ReadonlyArray<ScopeId>,
  visiting: Set<Node>,
  completed: WeakMap<Node, Array<ReadonlyArray<ScopeId>>>,
  issues: Array<GrammarIssue>,
): void => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Gen": {
      const inner = [...active, node.scope]
      for (const step of node.steps) walk(step.grammar, inner, visiting, completed, issues)
      return
    }
    case "Many":
      if (node.max > 0) {
        checkProgress(
          node.inner,
          node.max === Number.POSITIVE_INFINITY ? "unbounded repetition" : "repetition",
          issues,
        )
      }
      break
    case "Suspend":
      if (visiting.has(node)) return
      const paths = completed.get(node)
      if (paths?.some((path) => sameScopePath(path, active))) return
      visiting.add(node)
      try {
        let target: GrammarInternal
        try {
          target = resolve(node)
        } catch (error) {
          issues.push({
            message: `invalid suspend: ${exceptionMessage(error)}`,
          })
          return
        }
        walk(target, active, visiting, completed, issues)
      } finally {
        visiting.delete(node)
      }
      if (paths === undefined) completed.set(node, [active.slice()])
      else paths.push(active.slice())
      return
    case "Match":
      checkRef(node.scrutinee, "match", active, issues)
      break
    case "Take":
      checkRef(node.count, node.unit === "char" ? "take" : "bytes", active, issues)
      break
    case "RepeatExact":
      checkRef(node.count, "repeat", active, issues)
      // Bound counts can be nonzero, so their items must pass the progress check.
      if (node.count._tag !== "Count" || node.count.value > 0) {
        checkProgress(node.inner, "repetition", issues)
      }
      break
    default:
      break
  }
  for (const child of children(node)) walk(child, active, visiting, completed, issues)
}

// Check for refs outside their gen and nonzero repetitions of grammars proven
// to match empty input. May evaluate and cache suspension thunks.
// An empty result does not guarantee runtime success.
export const validate = (grammar: GrammarInternal): ReadonlyArray<GrammarIssue> => {
  const issues: Array<GrammarIssue> = []
  walk(grammar, [], new Set(), new WeakMap(), issues)
  return issues
}

export interface FidelityEntry {
  readonly name: string
  readonly fidelity: Fidelity
}

// List the transforms in a grammar that do not claim a full inverse law
// (`transform`, `transformOrFail`, `partialIso`). An empty result means each
// transform makes that claim; it does not prove the claim or a round trip.
export const auditFidelity = (grammar: GrammarInternal): ReadonlyArray<FidelityEntry> => {
  const entries: Array<FidelityEntry> = []
  eachNode(
    grammar,
    (node) => {
      if (node._tag === "Transform" && node.fidelity !== "claimed-iso") {
        entries.push({ name: node.name ?? describe(node.inner), fidelity: node.fidelity })
      }
    },
    new Set(),
  )
  return entries
}
