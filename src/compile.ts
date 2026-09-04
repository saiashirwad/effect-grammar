import { Result } from "effect"

import type {
  Expr,
  Fidelity,
  Grammar,
  GrammarInternal,
  GrammarIssue,
  Node,
  ScopeId,
} from "./core.ts"
import { children, nodeOf, resolve } from "./core.ts"
import type { ParseError, PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { print, printChecked } from "./print.ts"
import { describe, render } from "./render.ts"

const exprScope = (expr: Expr): ScopeId =>
  expr._tag === "Ref" ? expr.scope : exprScope(expr.object)

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

/** Check whether the grammar can be proved to match or reject empty input. */
const matchesEmpty = (grammar: GrammarInternal, seen: Set<Node>): EmptyMatch => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value === "" ? "yes" : "no"
    case "Regex":
      // `regex` always compiles with the sticky flag, so a match here is empty at 0.
      node.re.lastIndex = 0
      return node.re.exec("") === null ? "no" : "yes"
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
        const match = matchesEmpty(option, seen)
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
    case "Transform":
      return "unknown"
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
    case "Match":
    case "Take":
    case "RepeatExact":
      return "unknown"
  }
}

/** Walk every node reachable from `grammar`, once per `Suspend` node. */
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
  if (!active.includes(exprScope(expr))) {
    issues.push({
      message: `${where}: uses a ref bound by a gen that is not an ancestor here; a ref works only inside the gen that bound it`,
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
      if (node.max === Number.POSITIVE_INFINITY && matchesEmpty(node.inner, new Set()) === "yes") {
        issues.push({
          message: `unbounded repetition of ${describe(node.inner)}, which can match the empty string, so parsing could not make progress`,
        })
      }
      break
    case "Suspend":
      if (visiting.has(node)) return
      const paths = completed.get(node)
      if (paths?.some((path) => sameScopePath(path, active))) return
      visiting.add(node)
      try {
        for (const child of children(node)) walk(child, active, visiting, completed, issues)
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
      checkRef(node.count, "take", active, issues)
      break
    case "RepeatExact":
      checkRef(node.count, "repeat", active, issues)
      break
    default:
      break
  }
  for (const child of children(node)) walk(child, active, visiting, completed, issues)
}

/**
 * Check a grammar for staged errors that `parse` and `print` would otherwise
 * only report when they run: refs used outside their gen and unbounded
 * repetition of a grammar proven to match empty input. Returns the issues
 * these checks find; an empty array is not proof of all runtime behavior.
 */
export const validate = (grammar: GrammarInternal): ReadonlyArray<GrammarIssue> => {
  const issues: Array<GrammarIssue> = []
  walk(grammar, [], new Set(), new WeakMap(), issues)
  return issues
}

export interface FidelityEntry {
  readonly name: string
  readonly fidelity: Fidelity
}

/**
 * List the transforms in a grammar that do not claim a full inverse law
 * (`transform`, `transformOrFail`, `partialIso`). An empty result means each
 * transform makes that claim; it does not prove the claim or a round trip.
 */
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

export interface Compiled<A> {
  readonly parse: (text: string) => Result.Result<A, ParseError>
  readonly print: (value: A) => Result.Result<string, PrintError>
  readonly printChecked: (value: A) => Result.Result<string, PrintError>
  readonly render: string
  readonly fidelity: ReadonlyArray<FidelityEntry>
}

/**
 * Validate a grammar once, then return prepared operations bound to it.
 * Throws if {@link validate} finds an issue. Other input, value, callback, and
 * round-trip failures can still occur when a prepared operation runs.
 */
export const compile = <A>(grammar: Grammar<A>): Compiled<A> => {
  const issues = validate(grammar)
  if (issues.length > 0) {
    throw new Error(
      `compile: the grammar has ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n  ${issues
        .map((issue) => issue.message)
        .join("\n  ")}`,
    )
  }
  return {
    parse: (text) => parse(grammar, text),
    print: (value) => print(grammar, value),
    printChecked: (value) => printChecked(grammar, value),
    render: render(grammar),
    fidelity: auditFidelity(grammar),
  }
}
