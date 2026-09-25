import { type AnyGrammar, nodeOf } from "../core.ts"

/** A shallow name for messages. Never expands children or resolves suspensions. */
export const describe = (grammar: AnyGrammar): string => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return node.value === "" ? "empty" : JSON.stringify(node.value)
    case "Regex":
      return `/${node.source}/${node.flags}`
    case "Label":
      return node.name
    case "Suspend":
      return node.name ?? "suspend"
    case "Choice":
      return node.by === undefined ? "choice" : "dispatch"
    default:
      return node._tag.toLowerCase()
  }
}

export const describeStep = (step: AnyGrammar, index: number): string => `step ${index + 1} (${describe(step)})`
