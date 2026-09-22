import { Predicate } from "effect"

import { type AnyGrammar, type Expr, nodeOf, type Node, resolve, type ScopeId, type Value } from "./core.ts"
import { preview } from "./errors.ts"

const ChoicePrecedence = 1
const SequencePrecedence = 2
const PostfixPrecedence = 3
const AtomPrecedence = 4

interface Fragment {
  readonly precedence: number
  readonly text: string
}

interface Context {
  readonly expanding: Set<Node>
  readonly names: Map<ScopeId, Map<number, string>>
}

const atom = (text: string): Fragment => ({ precedence: AtomPrecedence, text })

const parenthesize = (fragment: Fragment, minimum: number): string =>
  fragment.precedence < minimum ? `(${fragment.text})` : fragment.text

const sequence = (fragments: ReadonlyArray<Fragment>): Fragment => ({
  precedence: SequencePrecedence,
  text: fragments
    .filter((fragment) => fragment.text !== "")
    .map((fragment) => parenthesize(fragment, SequencePrecedence))
    .join(" "),
})

const showExpr = (expr: Expr, context: Context): string => {
  if (expr._tag === "Ref") return context.names.get(expr.scope)?.get(expr.slot) ?? `$${expr.slot}`
  if (expr._tag === "Const") return String(expr.value)
  const object = showExpr(expr.object, context)
  return Predicate.isString(expr.key) && /^[A-Za-z_$][\w$]*$/.test(expr.key)
    ? `${object}.${expr.key}`
    : `${object}[${preview(expr.key)}]`
}

const showCases = (cases: ReadonlyArray<{ readonly key: Value; readonly grammar: AnyGrammar }>, context: Context) =>
  cases.map(({ key, grammar }) => `${preview(key)} => ${notation(grammar, context).text}`).join(" | ")

const repetition = (min: Expr, max: Expr | undefined, context: Context): string => {
  if (max === undefined) {
    if (min._tag !== "Const") return `{${showExpr(min, context)},}`
    return min.value === 0 ? "*" : min.value === 1 ? "+" : `{${min.value},}`
  }
  const low = showExpr(min, context)
  const high = showExpr(max, context)
  return low === high ? `{${low}}` : `{${low},${high}}`
}

const notation = (grammar: AnyGrammar, context: Context): Fragment => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return atom(node.value === "" ? "" : JSON.stringify(node.value))
    case "Regex":
      return atom(`/${node.source}/`)
    case "Take":
      return atom(`<take>{${showExpr(node.count, context)}}`)
    case "Gen": {
      let names = context.names.get(node.scope)
      if (names === undefined) context.names.set(node.scope, (names = new Map()))
      for (const [slot, path] of node.result.bindings) {
        if (path.length > 0) names.set(slot, path.join("."))
      }
      return sequence(
        node.steps.map((step, slot) => {
          const inner = notation(step, context)
          const name = names.get(slot)
          return name === undefined ? inner : atom(`${name}:${parenthesize(inner, PostfixPrecedence)}`)
        }),
      )
    }
    case "Wrap":
      return sequence([notation(node.open, context), notation(node.inner, context), notation(node.close, context)])
    case "Choice":
      return {
        precedence: ChoicePrecedence,
        text: node.options.map((option) => parenthesize(notation(option, context), SequencePrecedence)).join(" | "),
      }
    case "Dispatch":
      return atom(`on(${node.tag}){${showCases(node.cases, context)}}`)
    case "Match":
      return atom(`match(${showExpr(node.scrutinee, context)}){${showCases(node.cases, context)}}`)
    case "Optional":
      return { precedence: PostfixPrecedence, text: `(${notation(node.inner, context).text})?` }
    case "Repeat": {
      const inner = notation(node.inner, context)
      const sep = notation(node.sep, context)
      const unbounded = node.max === undefined
      const staticMin = node.min._tag === "Const" ? node.min.value : undefined
      const staticMax = node.max?._tag === "Const" ? node.max.value : undefined
      if (sep.text === "" || staticMax === 0) {
        return { precedence: PostfixPrecedence, text: `(${inner.text})${repetition(node.min, node.max, context)}` }
      }
      const rest = repetition(
        { _tag: "Const", value: Math.max(0, (staticMin ?? 0) - 1) },
        unbounded ? undefined : { _tag: "Const", value: Math.max(0, (staticMax ?? 0) - 1) },
        context,
      )
      const body = `${parenthesize(inner, SequencePrecedence)} (${parenthesize(sep, SequencePrecedence)} ${parenthesize(inner, SequencePrecedence)})${rest}`
      return staticMin === 0
        ? { precedence: PostfixPrecedence, text: `(${body})?` }
        : { precedence: SequencePrecedence, text: body }
    }
    case "Transform":
      return notation(node.inner, context)
    case "Label":
      return atom(`<${node.name}>`)
    case "Skip":
      return node.hidden ? atom("") : notation(node.inner, context)
    case "Suspend": {
      if (context.expanding.has(node)) return atom(node.name ?? "…")
      context.expanding.add(node)
      try {
        return notation(resolve(node), context)
      } catch (error) {
        return atom(`<invalid suspend: ${error instanceof Error ? error.message : preview(error)}>`)
      } finally {
        context.expanding.delete(node)
      }
    }
  }
}

export const render = (grammar: AnyGrammar): string =>
  parenthesize(notation(grammar, { expanding: new Set(), names: new Map() }), SequencePrecedence)

export const describe = (grammar: AnyGrammar): string => {
  const node = nodeOf(grammar)
  return node._tag === "Label" ? node.name : render(grammar)
}

export const describeStep = (step: AnyGrammar, index: number): string => `step ${index + 1} (${describe(step)})`
