import { type AnyGrammar, type Node, nodeOf, type Suspension } from "../core.ts"

type TargetOf = (node: Suspension) => AnyGrammar | undefined

export type SyntaxVerdict = "yes" | "no" | "unknown"

const combineSyntaxVerdicts = <T>(
  children: ReadonlyArray<T>,
  verdictOf: (child: T) => SyntaxVerdict,
): SyntaxVerdict => {
  let verdict: SyntaxVerdict = "yes"
  for (const child of children) {
    const each = verdictOf(child)
    if (each === "no") return "no"
    if (each === "unknown") verdict = "unknown"
  }
  return verdict
}

const proveSyntaxOnly = (grammar: AnyGrammar, seen: Set<Node>, targetOf: TargetOf): SyntaxVerdict => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Skip":
      return "yes"
    case "Regex":
    case "Take":
    case "Repeat":
    case "Dispatch":
      return "no"
    case "Sequence":
      if (
        !(node.output._tag === "Const" && node.output.value === undefined)
        && node.output._tag !== "Slot"
      ) return "no"
      return combineSyntaxVerdicts(node.steps, (step) => proveSyntaxOnly(step.grammar, seen, targetOf))
    case "Choice":
      return combineSyntaxVerdicts(node.options, (option) => proveSyntaxOnly(option, seen, targetOf))
    case "Match":
      return combineSyntaxVerdicts(node.cases, ({ grammar }) => proveSyntaxOnly(grammar, seen, targetOf))
    case "Transform":
    case "Filter":
      return "no"
    case "Optional":
    case "Surrounded":
    case "Label":
      return proveSyntaxOnly(node.inner, seen, targetOf)
    case "Suspend": {
      if (seen.has(node)) return "unknown"
      const target = targetOf(node)
      if (target === undefined) return "unknown"
      seen.add(node)
      const verdict = proveSyntaxOnly(target, seen, targetOf)
      seen.delete(node)
      return verdict
    }
  }
}

export const syntaxVerdict = (grammar: AnyGrammar, targetOf: TargetOf): SyntaxVerdict =>
  proveSyntaxOnly(grammar, new Set(), targetOf)

export const cachedSyntaxVerdict = (grammar: AnyGrammar): SyntaxVerdict =>
  syntaxVerdict(grammar, (suspension) => suspension.resolved)
