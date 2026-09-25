import { Result } from "effect"

import { type AnyGrammar, type Node, nodeOf } from "../core.ts"

/** The encode of optional's present branch. Its decode is the identity, so its output is its inner's. */
export const presentOnly = <A>(value: A | undefined): Result.Result<A, string> =>
  value === undefined ? Result.fail("a present value") : Result.succeed(value)

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
    case "Repeat":
    case "Dispatch":
      return false
    case "Gen":
      return (
        ((node.result.tree._tag === "Const" && node.result.tree.value === undefined)
          || (node.result.tree._tag === "Ref" && node.result.tree.scope === node.scope))
        && node.steps.every((step) => canOmit(step, seen, targetOf))
      )
    case "Choice":
      return node.options.every((option) => canOmit(option, seen, targetOf))
    case "Match":
      return node.cases.every(({ grammar }) => canOmit(grammar, seen, targetOf))
    case "Transform":
      return node.encode === presentOnly && canOmit(node.inner, seen, targetOf)
    case "Label":
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
