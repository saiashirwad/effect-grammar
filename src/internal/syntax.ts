import { Result } from "effect"

import { type AnyGrammar, type Node, nodeOf } from "../core.ts"

/** The encode of optional's present branch. Its decode is the identity, so its output is its inner's. */
export const presentOnly = <A>(value: A | undefined): Result.Result<A, string> =>
  value === undefined ? Result.fail("a present value") : Result.succeed(value)

type TargetOf = (node: Extract<Node, { readonly _tag: "Suspend" }>) => AnyGrammar | undefined

/** "yes": provably syntax-only. "no": provably produces a value. "unknown": depends on an unavailable suspension or a cycle. */
export type Syntax = "yes" | "no" | "unknown"

// Every child must be syntax-only. Stops at the first proof of a value, as `every` did.
const all = <T>(children: ReadonlyArray<T>, verdictOf: (child: T) => Syntax): Syntax => {
  let verdict: Syntax = "yes"
  for (const child of children) {
    const each = verdictOf(child)
    if (each === "no") return "no"
    if (each === "unknown") verdict = "unknown"
  }
  return verdict
}

// Only prove syntax/discard output. A cycle proves neither way, and an opaque value
// producer needs an explicit skip, even when its printer happens to accept undefined.
const syntaxOf = (grammar: AnyGrammar, seen: Set<Node>, targetOf: TargetOf): Syntax => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Skip":
      return "yes"
    case "Regex":
    case "Take":
    case "Repeat":
      return "no"
    case "Gen":
      if (
        !(node.result.tree._tag === "Const" && node.result.tree.value === undefined)
        && !(node.result.tree._tag === "Ref" && node.result.tree.scope === node.scope)
      ) return "no"
      return all(node.steps, (step) => syntaxOf(step, seen, targetOf))
    case "Choice":
      // A dispatch prints from a tagged object, so it always needs a value.
      if (node.by !== undefined) return "no"
      return all(node.options, (option) => syntaxOf(option, seen, targetOf))
    case "Match":
      return all(node.cases, ({ grammar }) => syntaxOf(grammar, seen, targetOf))
    case "Transform":
      return node.encode === presentOnly ? syntaxOf(node.inner, seen, targetOf) : "no"
    case "Label":
      return syntaxOf(node.inner, seen, targetOf)
    case "Suspend": {
      if (seen.has(node)) return "unknown"
      const target = targetOf(node)
      if (target === undefined) return "unknown"
      seen.add(node)
      const verdict = syntaxOf(target, seen, targetOf)
      seen.delete(node)
      return verdict
    }
  }
}

export const syntax = (grammar: AnyGrammar, targetOf: TargetOf): Syntax => syntaxOf(grammar, new Set(), targetOf)

export const isSyntaxOnly = (grammar: AnyGrammar, targetOf: TargetOf): boolean => syntax(grammar, targetOf) === "yes"
