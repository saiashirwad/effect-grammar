import { Result, Schema } from "effect"

import {
  type AnyGrammar,
  type Expr,
  type Fidelity,
  type Grammar,
  type GrammarIssue,
  type Node,
  nodeOf,
  resolve,
  type ScopeId,
} from "./core.ts"
import { exceptionMessage, type ParseError, type PrintError } from "./errors.ts"
import { parse } from "./parse.ts"
import { print, printChecked } from "./print.ts"
import { describe, render } from "./render.ts"

// The grammars a node refers to directly. A `Suspend` yields its resolved target.
const children = (node: Node): ReadonlyArray<AnyGrammar> => {
  switch (node._tag) {
    case "Literal":
    case "Regex":
    case "Take":
      return []
    case "Gen":
      return node.steps.map((step) => step.grammar)
    case "Wrap":
      return [node.open, node.inner, node.close]
    case "Merge":
      return node.parts.map((part) => part.grammar)
    case "Choice":
      return node.options
    case "Dispatch":
    case "Match":
      return node.cases.map((matchCase) => matchCase.grammar)
    case "Repeat":
      return [node.inner, node.sep]
    case "Optional":
    case "Transform":
    case "Skip":
    case "Label":
      return [node.inner]
    case "Suspend":
      return [resolve(node)]
  }
}

// ---------------------------------------------------------------------------
// Can a grammar match the empty string?

type EmptyMatch = "yes" | "no" | "unknown"

const allMatchEmpty = (grammars: Iterable<AnyGrammar>, seen: Set<Node>): EmptyMatch => {
  let result: EmptyMatch = "yes"
  for (const grammar of grammars) {
    const match = matchesEmpty(grammar, seen)
    if (match === "no") return "no"
    if (match === "unknown") result = "unknown"
  }
  return result
}

const matchesEmpty = (grammar: AnyGrammar, seen: Set<Node>): EmptyMatch => {
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
      return allMatchEmpty(
        node.steps.map((step) => step.grammar),
        seen,
      )
    case "Wrap":
      return allMatchEmpty([node.open, node.inner, node.close], seen)
    case "Merge":
      return allMatchEmpty(
        node.parts.map((part) => part.grammar),
        seen,
      )
    case "Choice":
    case "Dispatch": {
      let result: EmptyMatch = "no"
      for (const option of children(node)) {
        const match = matchesEmpty(option, new Set(seen))
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
      const item = matchesEmpty(node.inner, seen)
      // A zero-width item makes the repetition fail its own progress guard.
      if (item === "yes") return "no"
      if (item === "unknown") return "unknown"
      return node.min.value === 0 ? "yes" : "no"
    }
    case "Transform": {
      const inner = matchesEmpty(node.inner, seen)
      return inner === "yes" ? "unknown" : inner
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
  }
}

// ---------------------------------------------------------------------------
// Static checks

type ScopePath = ReadonlyArray<ScopeId>

const exprScope = (expr: Expr): ScopeId | undefined =>
  expr._tag === "Ref" ? expr.scope : expr._tag === "Prop" ? exprScope(expr.object) : undefined

const sameScopePath = (left: ScopePath, right: ScopePath): boolean =>
  left.length === right.length && left.every((scope, index) => scope === right[index])

interface Walk {
  readonly issues: Array<GrammarIssue>
  readonly visiting: Set<Node>
  // A suspend's target depends on the enclosing gens, so it is walked once per scope path.
  readonly walkedUnder: WeakMap<Node, Array<ScopePath>>
}

const walk = (grammar: AnyGrammar, active: ScopePath, state: Walk): void => {
  const node = nodeOf(grammar)

  const checkRef = (expr: Expr, where: string): void => {
    const scope = exprScope(expr)
    if (scope !== undefined && !active.includes(scope)) {
      state.issues.push({
        message: `${where}: uses a ref bound by a gen that is not an ancestor here; a ref works only inside the gen that bound it`,
      })
    }
  }

  const checkProgress = (inner: AnyGrammar, repetition: string): void => {
    if (matchesEmpty(inner, new Set()) === "yes") {
      state.issues.push({
        message: `${repetition} of ${describe(inner)}, which can match the empty string, so parsing and printing would disagree about zero-width elements`,
      })
    }
  }

  if (node._tag === "Gen") {
    const inner = [...active, node.scope]
    for (const step of node.steps) walk(step.grammar, inner, state)
    return
  }

  if (node._tag === "Suspend") {
    if (state.visiting.has(node)) return
    const paths = state.walkedUnder.get(node)
    if (paths?.some((path) => sameScopePath(path, active))) return
    let target: AnyGrammar
    try {
      target = resolve(node)
    } catch (error) {
      state.issues.push({ message: `invalid suspend: ${exceptionMessage(error)}` })
      return
    }
    state.visiting.add(node)
    try {
      walk(target, active, state)
    } finally {
      state.visiting.delete(node)
    }
    if (paths === undefined) state.walkedUnder.set(node, [active])
    else paths.push(active)
    return
  }

  switch (node._tag) {
    case "Repeat": {
      if (node.min._tag !== "Const") checkRef(node.min, "repeat")
      if (node.max !== undefined && node.max._tag !== "Const") checkRef(node.max, "repeat")
      // Only a repetition that must run zero times can tolerate a zero-width item.
      if (node.max === undefined || node.max._tag !== "Const" || node.max.value > 0) {
        checkProgress(node.inner, node.max === undefined ? "unbounded repetition" : "repetition")
      }
      break
    }
    case "Match":
      checkRef(node.scrutinee, "match")
      break
    case "Take":
      checkRef(node.count, node.unit === "char" ? "take" : "bytes")
      break
  }
  for (const child of children(node)) walk(child, active, state)
}

// Check for refs outside their gen and nonzero repetitions of grammars proven
// to match empty input. May evaluate and cache suspension thunks.
// An empty result does not guarantee runtime success.
export const validate = (grammar: AnyGrammar): ReadonlyArray<GrammarIssue> => {
  const state: Walk = { issues: [], visiting: new Set(), walkedUnder: new WeakMap() }
  walk(grammar, [], state)
  return state.issues
}

export interface FidelityEntry {
  readonly name: string
  readonly fidelity: Fidelity
}

// List the transforms in a grammar that do not claim a full inverse law
// (`transform`, `transformOrFail`, `partialIso`). An empty result means each
// transform makes that claim; it does not prove the claim or a round trip.
export const auditFidelity = (grammar: AnyGrammar): ReadonlyArray<FidelityEntry> => {
  const entries: Array<FidelityEntry> = []
  const seen = new Set<Node>()
  const visit = (grammar: AnyGrammar): void => {
    const node = nodeOf(grammar)
    if (node._tag === "Suspend") {
      if (seen.has(node)) return
      seen.add(node)
    }
    if (node._tag === "Transform" && node.fidelity !== "claimed-iso") {
      entries.push({ name: node.name ?? describe(node.inner), fidelity: node.fidelity })
    }
    for (const child of children(node)) visit(child)
  }
  visit(grammar)
  return entries
}

// ---------------------------------------------------------------------------
// Validate once, then use the grammar

export interface Prepared<A> {
  readonly parse: (text: string) => Result.Result<A, ParseError>
  readonly print: (value: A) => Result.Result<string, PrintError>
  readonly printChecked: (value: A) => Result.Result<string, PrintError>
  readonly render: string
  readonly audit: ReadonlyArray<FidelityEntry>
}

export class GrammarValidationError extends Schema.TaggedError<GrammarValidationError>()("GrammarValidationError", {
  issues: Schema.Array(Schema.Struct({ message: Schema.String })),
}) {
  override get message(): string {
    return `prepare: the grammar has ${this.issues.length} issue${this.issues.length === 1 ? "" : "s"}:\n  ${this.issues
      .map((issue) => issue.message)
      .join("\n  ")}`
  }
}

export const prepare = <A>(grammar: Grammar<A>): Result.Result<Prepared<A>, GrammarValidationError> => {
  const issues = validate(grammar)
  if (issues.length > 0) return Result.fail(new GrammarValidationError({ issues: [...issues] }))
  return Result.succeed({
    parse: (text: string) => parse(grammar, text),
    print: (value: A) => print(grammar, value),
    printChecked: (value: A) => printChecked(grammar, value),
    render: render(grammar),
    audit: auditFidelity(grammar),
  })
}
