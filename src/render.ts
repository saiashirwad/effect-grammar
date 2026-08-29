import { Predicate, Result } from "effect"

import {
  assertClosed,
  type Bounds,
  type Expr,
  type GrammarInternal,
  nodeOf,
  type Node,
  type Pattern,
  resolve,
  type ScopeId,
  type Step,
} from "./core.ts"
import { preview, UnsupportedGrammar } from "./errors.ts"

const ChoicePrecedence = 1
const SequencePrecedence = 2
const PostfixPrecedence = 3
const AtomPrecedence = 4

interface Fragment {
  readonly precedence: number
  readonly text: string
}

interface Context {
  readonly seen: Set<Node>
  readonly names: Map<ScopeId, Map<number, string>>
  readonly includeBindings: boolean
}

const repetition = ({ min, max }: Bounds): string => {
  if (max === Number.POSITIVE_INFINITY) return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
  return min === max ? `{${min}}` : `{${min},${max}}`
}

const parenthesize = (fragment: Fragment, minimum: number): string =>
  fragment.precedence < minimum ? `(${fragment.text})` : fragment.text

const sequence = (fragments: ReadonlyArray<Fragment>): Fragment => ({
  precedence: SequencePrecedence,
  text: fragments
    .filter((fragment) => fragment.text !== "")
    .map((fragment) => parenthesize(fragment, SequencePrecedence))
    .join(" "),
})

const namesFor = (context: Context, scope: ScopeId): Map<number, string> => {
  const existing = context.names.get(scope)
  if (existing !== undefined) return existing
  const names = new Map<number, string>()
  context.names.set(scope, names)
  return names
}

const nameBindings = (
  pattern: Pattern,
  path: string | undefined,
  scope: ScopeId,
  names: Map<number, string>,
): void => {
  switch (pattern._tag) {
    case "Ref":
      if (pattern.scope === scope && path !== undefined) names.set(pattern.slot, path)
      return
    case "Const":
      return
    case "Object":
      for (const [key, field] of pattern.fields) {
        nameBindings(field, path === undefined ? key : `${path}.${key}`, scope, names)
      }
      return
    case "Array":
      pattern.items.forEach((item, index) => {
        nameBindings(item, path === undefined ? String(index) : `${path}.${index}`, scope, names)
      })
  }
}

const showExpr = (expr: Expr, context: Context): string => {
  if (expr._tag === "Ref") return context.names.get(expr.scope)?.get(expr.slot) ?? `$${expr.slot}`
  const object = showExpr(expr.object, context)
  return Predicate.isString(expr.key) && /^[A-Za-z_$][\w$]*$/.test(expr.key)
    ? `${object}.${expr.key}`
    : `${object}[${preview(expr.key)}]`
}

const show = (grammar: GrammarInternal, context: Context): Fragment => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return {
        precedence: AtomPrecedence,
        text: node.value === "" ? "" : JSON.stringify(node.value),
      }
    case "Regex":
      return { precedence: AtomPrecedence, text: `<${node.name}>` }
    case "Gen": {
      const names = namesFor(context, node.scope)
      if (context.includeBindings) nameBindings(node.result, undefined, node.scope, names)
      return sequence(
        node.steps.map((step) => {
          const inner = show(step.grammar, context)
          const name = step._tag === "Bind" ? names.get(step.slot) : undefined
          return name === undefined
            ? inner
            : {
                precedence: AtomPrecedence,
                text: `${name}:${parenthesize(inner, PostfixPrecedence)}`,
              }
        }),
      )
    }
    case "Wrap":
      return sequence([
        show(node.open, context),
        show(node.inner, context),
        show(node.close, context),
      ])
    case "Choice":
      return {
        precedence: ChoicePrecedence,
        text: node.options
          .map((option) => parenthesize(show(option, context), SequencePrecedence))
          .join(" | "),
      }
    case "Many": {
      const inner = show(node.inner, context)
      const sep = show(node.sep, context)
      if (sep.text === "" || node.max === 0) {
        return {
          precedence: PostfixPrecedence,
          text: `(${inner.text})${repetition(node)}`,
        }
      }
      const rest = repetition({
        min: Math.max(0, node.min - 1),
        max: node.max === Number.POSITIVE_INFINITY ? node.max : Math.max(0, node.max - 1),
      })
      const body = `${parenthesize(inner, SequencePrecedence)} (${parenthesize(sep, SequencePrecedence)} ${parenthesize(inner, SequencePrecedence)})${rest}`
      return node.min === 0
        ? { precedence: PostfixPrecedence, text: `(${body})?` }
        : { precedence: SequencePrecedence, text: body }
    }
    case "Optional":
      return { precedence: PostfixPrecedence, text: `(${show(node.inner, context).text})?` }
    case "Transform":
    case "TransformOrFail":
    case "Label":
      return show(node.inner, context)
    case "Skip":
      return node.show ? show(node.inner, context) : { precedence: AtomPrecedence, text: "" }
    case "Suspend": {
      if (context.seen.has(node)) {
        return { precedence: AtomPrecedence, text: node.name ?? "…" }
      }
      context.seen.add(node)
      const fragment = show(resolve(node), context)
      context.seen.delete(node)
      return fragment
    }
    case "Match": {
      const cases = node.cases.map(
        (matchCase) => `${preview(matchCase.key)} => ${show(matchCase.grammar, context).text}`,
      )
      return {
        precedence: AtomPrecedence,
        text: `match(${showExpr(node.scrutinee, context)}){${cases.join(" | ")}}`,
      }
    }
    case "Dependent": {
      const text = node.show(
        node.deps.map((dep) => showExpr(dep, context)),
        (inner) => show(inner, context).text,
      )
      return { precedence: AtomPrecedence, text }
    }
    case "Take":
      return { precedence: AtomPrecedence, text: `<char>{${showExpr(node.count, context)}}` }
    case "RepeatExact":
      return {
        precedence: PostfixPrecedence,
        text: `(${show(node.inner, context).text}){${showExpr(node.count, context)}}`,
      }
  }
}

const context = (includeBindings: boolean): Context => ({
  seen: new Set(),
  names: new Map(),
  includeBindings,
})

export const renderInternal = (grammar: GrammarInternal): string =>
  parenthesize(show(grammar, context(true)), SequencePrecedence)

export const render = (grammar: GrammarInternal): string => {
  assertClosed(grammar, "render")
  return renderInternal(grammar)
}

export const describe = (grammar: GrammarInternal): string => {
  const node = nodeOf(grammar)
  return node._tag === "Regex" || node._tag === "Label" ? node.name : renderInternal(grammar)
}

export const describeStep = (step: Step, index: number): string =>
  `step ${index + 1} (${describe(step.grammar)})`

const unsupported = (grammar: GrammarInternal, seen: Set<Node>): string | undefined => {
  const node = nodeOf(grammar)
  if (seen.has(node)) return undefined
  seen.add(node)

  let reason: string | undefined
  switch (node._tag) {
    case "Match":
    case "Dependent":
    case "Take":
    case "RepeatExact":
      reason = `${node._tag} is context-dependent and cannot be represented as EBNF`
      break
    case "Gen":
      for (const step of node.steps) {
        reason = unsupported(step.grammar, seen)
        if (reason !== undefined) break
      }
      break
    case "Wrap":
      reason =
        unsupported(node.open, seen) ??
        unsupported(node.inner, seen) ??
        unsupported(node.close, seen)
      break
    case "Choice":
      for (const option of node.options) {
        reason = unsupported(option, seen)
        if (reason !== undefined) break
      }
      break
    case "Many":
      reason = unsupported(node.inner, seen) ?? unsupported(node.sep, seen)
      break
    case "Optional":
    case "Transform":
    case "TransformOrFail":
    case "Skip":
    case "Label":
      reason = unsupported(node.inner, seen)
      break
    case "Suspend":
      reason = unsupported(resolve(node), seen)
      break
    case "Literal":
    case "Regex":
      break
  }

  seen.delete(node)
  return reason
}

export const toEBNF = (grammar: GrammarInternal): Result.Result<string, UnsupportedGrammar> => {
  assertClosed(grammar, "toEBNF")
  const reason = unsupported(grammar, new Set())
  return reason === undefined
    ? Result.succeed(parenthesize(show(grammar, context(false)), SequencePrecedence))
    : Result.fail(new UnsupportedGrammar({ reason }))
}
