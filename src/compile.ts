import { Predicate, Result } from "effect"

import type {
  Count,
  Expr,
  Fidelity,
  Grammar,
  GrammarInternal,
  GrammarIssue,
  InputKind,
  Node,
  ScopeId,
} from "./core.ts"
import { children, derivations, inputOf, nodeOf, resolve } from "./core.ts"
import type { ParseError, PrintError } from "./errors.ts"
import { type Format, type Input, textFormat } from "./format.ts"
import { parseWith } from "./parse.ts"
import { printCheckedWith, printWith } from "./print.ts"
import { describe, render } from "./render.ts"

/** A `derive` that was not yielded directly by its gen, so no gen hoisted it. */
export const freeDerive =
  "derive: must be yielded directly by the gen that binds its target, not nested in another grammar"

const exprScope = (expr: Expr): ScopeId =>
  expr._tag === "Ref" ? expr.scope : exprScope(expr._tag === "Map" ? expr.expr : expr.object)

type EmptyMatch = "yes" | "no" | "unknown"

const countEmpty = (count: Count): EmptyMatch =>
  Predicate.isNumber(count) ? (count === 0 ? "yes" : "no") : "unknown"

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
    case "Empty":
    case "Derive":
      return "yes"
    case "Literal":
    case "Number":
    case "VarInt":
      return "no"
    case "ByteLiteral":
      return node.value.length === 0 ? "yes" : "no"
    case "Bytes":
    case "Take":
      return countEmpty(node.count)
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
      return "unknown"
    case "RepeatExact":
      return node.count === 0
        ? "yes"
        : Predicate.isNumber(node.count)
          ? matchesEmpty(node.inner, seen)
          : "unknown"
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
  count: Count,
  where: string,
  active: ReadonlyArray<ScopeId>,
  issues: Array<GrammarIssue>,
): void => {
  if (!Predicate.isNumber(count) && !active.includes(exprScope(count))) {
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
      for (const step of node.steps) {
        if (nodeOf(step.grammar)._tag === "Derive") continue
        walk(step.grammar, inner, visiting, completed, issues)
      }
      for (const { expr } of derivations(node.steps)) checkRef(expr, "derive", inner, issues)
      return
    }
    case "Derive":
      issues.push({ message: freeDerive })
      return
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
    case "Bytes":
      checkRef(node.count, "bytes", active, issues)
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
 * only report when they run: refs used outside their gen, unbounded
 * repetition of a grammar proven to match empty input, and terminals that
 * read a different kind of input. Returns the issues these checks find; an
 * empty array is not proof of all runtime behavior.
 */
export const validateWith = (
  grammar: GrammarInternal,
  input: InputKind,
): ReadonlyArray<GrammarIssue> => {
  const issues: Array<GrammarIssue> = []
  walk(grammar, [], new Set(), new WeakMap(), issues)
  eachNode(
    grammar,
    (node) => {
      const kind = inputOf(node)
      if (kind !== undefined && kind !== input) {
        issues.push({ message: `${node._tag} cannot be used with ${input} input` })
      }
    },
    new Set(),
  )
  return issues
}

export const validate = (grammar: GrammarInternal): ReadonlyArray<GrammarIssue> =>
  validateWith(grammar, "text")

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

export interface Compiled<A, I extends Input = string, E extends Error = ParseError> {
  readonly parse: (input: I) => Result.Result<A, E>
  readonly print: (value: A) => Result.Result<I, PrintError>
  readonly printChecked: (value: A) => Result.Result<I, PrintError>
  readonly render: string
  readonly fidelity: ReadonlyArray<FidelityEntry>
}

export const compileWith = <A, I extends Input, E extends Error>(
  grammar: Grammar<A>,
  format: Format<I, E>,
): Compiled<A, I, E> => {
  const issues = validateWith(grammar, format.kind)
  if (issues.length > 0) {
    throw new Error(
      `compile: the grammar has ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n  ${issues
        .map((issue) => issue.message)
        .join("\n  ")}`,
    )
  }
  return {
    parse: (input) => parseWith(grammar, input, format),
    print: (value) => printWith(grammar, value, format),
    printChecked: (value) => printCheckedWith(grammar, value, format),
    render: render(grammar),
    fidelity: auditFidelity(grammar),
  }
}

/**
 * Validate a grammar once, then return prepared operations bound to it.
 * Throws if {@link validate} finds an issue. Other input, value, callback, and
 * round-trip failures can still occur when a prepared operation runs.
 */
export const compile = <A>(grammar: Grammar<A>): Compiled<A> => compileWith(grammar, textFormat)
