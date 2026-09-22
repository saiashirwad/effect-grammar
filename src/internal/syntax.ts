import { type AnyGrammar, type Node, nodeOf } from "../core.ts"

type TargetOf = (node: Extract<Node, { readonly _tag: "Suspend" }>) => AnyGrammar | undefined

// Only prove syntax/discard output. A cycle or an opaque value producer needs an
// explicit skip, even when its printer happens to accept undefined.
const canOmit = (grammar: AnyGrammar, seen: Set<Node>, targetOf: TargetOf): boolean => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Skip":
      return true
    case "Regex":
    case "Take":
    case "Transform":
    case "Repeat":
    case "Dispatch":
      return false
    case "Gen":
      return (
        ((node.result.tree._tag === "Const" && node.result.tree.value === undefined) ||
          (node.result.tree._tag === "Ref" && node.result.tree.scope === node.scope)) &&
        node.steps.every((step) => canOmit(step, seen, targetOf))
      )
    case "Choice":
      return node.options.every((option) => canOmit(option, seen, targetOf))
    case "Match":
      return node.cases.every(({ grammar }) => canOmit(grammar, seen, targetOf))
    case "Label":
    case "Optional":
      return canOmit(node.inner, seen, targetOf)
    case "Suspend": {
      if (seen.has(node)) return false
      const target = targetOf(node)
      if (target === undefined) return false
      seen.add(node)
      const omitted = canOmit(target, seen, targetOf)
      seen.delete(node)
      return omitted
    }
  }
}

export const isSyntaxOnly = (grammar: AnyGrammar, targetOf: TargetOf): boolean => canOmit(grammar, new Set(), targetOf)
