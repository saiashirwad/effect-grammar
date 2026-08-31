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

/**
 * True only when the grammar provably matches the empty string. Unknown cases
 * (a `Match` key, a `take` count, an unresolved `Suspend`) return `false`, so
 * the check never reports a false positive.
 */
const matchesEmpty = (grammar: GrammarInternal, seen: Set<Node>): boolean => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value === ""
    case "Regex":
      // `regex` always compiles with the sticky flag, so a match here is empty at 0.
      node.re.lastIndex = 0
      return node.re.exec("") !== null
    case "Gen":
      return node.steps.every((step) => matchesEmpty(step.grammar, seen))
    case "Wrap":
      return (
        matchesEmpty(node.open, seen) &&
        matchesEmpty(node.inner, seen) &&
        matchesEmpty(node.close, seen)
      )
    case "Choice":
      return node.options.some((option) => matchesEmpty(option, seen))
    case "Many":
      return node.min === 0 || matchesEmpty(node.inner, seen)
    case "Optional":
      return true
    case "Transform":
    case "Label":
    case "Skip":
      return matchesEmpty(node.inner, seen)
    case "Suspend": {
      if (seen.has(node)) return false
      seen.add(node)
      const empty = matchesEmpty(resolve(node), seen)
      seen.delete(node)
      return empty
    }
    case "Match":
    case "Take":
    case "RepeatExact":
      return false
  }
}

/** Walk every node reachable from `grammar`, once per `Suspend`. */
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

const walk = (
  grammar: GrammarInternal,
  active: ReadonlyArray<ScopeId>,
  seen: Set<Node>,
  issues: Array<GrammarIssue>,
): void => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Gen": {
      const inner = [...active, node.scope]
      for (const step of node.steps) walk(step.grammar, inner, seen, issues)
      return
    }
    case "Many":
      if (node.max === Number.POSITIVE_INFINITY && matchesEmpty(node.inner, new Set())) {
        issues.push({
          message: `unbounded repetition of ${describe(node.inner)}, which can match the empty string, so parsing could not make progress`,
        })
      }
      break
    case "Suspend":
      if (seen.has(node)) return
      seen.add(node)
      break
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
  for (const child of children(node)) walk(child, active, seen, issues)
}

/**
 * Check a grammar for staged errors that `parse` and `print` would otherwise
 * only report when they run: refs used outside their gen and unbounded
 * repetition of an empty-matching grammar. Returns the issues it finds, or an
 * empty array when the grammar is sound.
 */
export const validate = (grammar: GrammarInternal): ReadonlyArray<GrammarIssue> => {
  const issues: Array<GrammarIssue> = []
  walk(grammar, [], new Set(), issues)
  return issues
}

export interface FidelityEntry {
  readonly name: string
  readonly fidelity: Fidelity
}

/**
 * List the transforms in a grammar that claim no inverse law (`transform`,
 * `transformOrFail`, `partialIso`). An empty result means every transform is an
 * `iso`, `decodeTo`, `as`, or the like, so nothing silently breaks round trips.
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
 * Throws if {@link validate} finds any issue, so a compiled grammar is known
 * sound before its first parse or print.
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
