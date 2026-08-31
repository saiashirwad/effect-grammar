import { Result } from "effect"

import type {
  Expr,
  Fidelity,
  Grammar,
  GrammarInternal,
  GrammarIssue,
  MatchKey,
  Node,
  ScopeId,
} from "./core.ts"
import { nodeOf, resolve } from "./core.ts"
import type { ParseError } from "./errors.ts"
import { preview, type PrintError } from "./errors.ts"
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
    case "Regex": {
      node.re.lastIndex = 0
      const match = node.re.exec("")
      return match !== null && match.index === 0 && match[0] === ""
    }
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

const duplicateKeys = (keys: ReadonlyArray<MatchKey>): ReadonlyArray<MatchKey> => {
  const seen = new Set<MatchKey>()
  const dupes = new Set<MatchKey>()
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key)
    seen.add(key)
  }
  return [...dupes]
}

const walk = (
  grammar: GrammarInternal,
  active: ReadonlyArray<ScopeId>,
  seen: Set<Node>,
  issues: Array<GrammarIssue>,
): void => {
  const node = nodeOf(grammar)
  const checkRef = (expr: Expr, where: string): void => {
    if (!active.includes(exprScope(expr))) {
      issues.push({
        message: `${where}: uses a ref bound by a gen that is not an ancestor here; a ref works only inside the gen that bound it`,
      })
    }
  }
  switch (node._tag) {
    case "Literal":
    case "Regex":
      return
    case "Gen": {
      const inner = [...active, node.scope]
      for (const step of node.steps) walk(step.grammar, inner, seen, issues)
      return
    }
    case "Wrap":
      walk(node.open, active, seen, issues)
      walk(node.inner, active, seen, issues)
      walk(node.close, active, seen, issues)
      return
    case "Choice": {
      if (node.on !== undefined) {
        for (const key of duplicateKeys(node.on.keys)) {
          issues.push({ message: `choiceOn(${node.on.tag}): duplicate key ${preview(key)}` })
        }
      }
      for (const option of node.options) walk(option, active, seen, issues)
      return
    }
    case "Many": {
      if (node.max === Number.POSITIVE_INFINITY && matchesEmpty(node.inner, new Set())) {
        issues.push({
          message: `unbounded repetition of ${describe(node.inner)}, which can match the empty string, so parsing could not make progress`,
        })
      }
      walk(node.inner, active, seen, issues)
      walk(node.sep, active, seen, issues)
      return
    }
    case "Optional":
    case "Transform":
    case "Label":
    case "Skip":
      walk(node.inner, active, seen, issues)
      return
    case "Suspend": {
      if (seen.has(node)) return
      seen.add(node)
      walk(resolve(node), active, seen, issues)
      return
    }
    case "Match": {
      checkRef(node.scrutinee, "match")
      for (const key of duplicateKeys(node.cases.map((matchCase) => matchCase.key))) {
        issues.push({ message: `match: duplicate case key ${preview(key)}` })
      }
      for (const matchCase of node.cases) walk(matchCase.grammar, active, seen, issues)
      return
    }
    case "Take":
      checkRef(node.count, "take")
      return
    case "RepeatExact":
      checkRef(node.count, "repeat")
      walk(node.inner, active, seen, issues)
      return
  }
}

/**
 * Check a grammar for staged errors that `parse` and `print` would otherwise
 * only report when they run: refs used outside their gen, duplicate discriminant
 * keys, and unbounded repetition of an empty-matching grammar. Returns the
 * issues it finds, or an empty array when the grammar is sound.
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

const collectFidelity = (
  grammar: GrammarInternal,
  seen: Set<Node>,
  entries: Array<FidelityEntry>,
): void => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Regex":
    case "Take":
      return
    case "Transform":
      if (node.fidelity !== "claimed-iso") {
        entries.push({ name: node.name ?? describe(node.inner), fidelity: node.fidelity })
      }
      collectFidelity(node.inner, seen, entries)
      return
    case "Gen":
      for (const step of node.steps) collectFidelity(step.grammar, seen, entries)
      return
    case "Wrap":
      collectFidelity(node.open, seen, entries)
      collectFidelity(node.inner, seen, entries)
      collectFidelity(node.close, seen, entries)
      return
    case "Choice":
      for (const option of node.options) collectFidelity(option, seen, entries)
      return
    case "Many":
      collectFidelity(node.inner, seen, entries)
      collectFidelity(node.sep, seen, entries)
      return
    case "Optional":
    case "Label":
    case "Skip":
    case "RepeatExact":
      collectFidelity(node.inner, seen, entries)
      return
    case "Suspend": {
      if (seen.has(node)) return
      seen.add(node)
      collectFidelity(resolve(node), seen, entries)
      return
    }
    case "Match":
      for (const matchCase of node.cases) collectFidelity(matchCase.grammar, seen, entries)
      return
  }
}

/**
 * List the transforms in a grammar that claim no inverse law (`transform`,
 * `transformOrFail`, `partialIso`). An empty result means every transform is an
 * `iso`, `decodeTo`, `as`, or the like, so nothing silently breaks round trips.
 */
export const auditFidelity = (grammar: GrammarInternal): ReadonlyArray<FidelityEntry> => {
  const entries: Array<FidelityEntry> = []
  collectFidelity(grammar, new Set(), entries)
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
