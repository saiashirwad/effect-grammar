import { type Bounds, type Grammar, isField, type Node, type Part, resolve } from "./core.ts"

const repetition = ({ min, max }: Bounds): string => {
  if (max === Number.POSITIVE_INFINITY) return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
  return min === max ? `{${min}}` : `{${min},${max}}`
}

const words = (parts: ReadonlyArray<string>): string => parts.filter((p) => p !== "").join(" ")

const showPart = (p: Part, seen: Set<Node>): string =>
  isField(p) ? `${p.name}:${show(p.grammar, seen)}` : show(p, seen)

const show = (g: Grammar<unknown>, seen: Set<Node>): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value === "" ? "" : JSON.stringify(n.value)
    case "Regex":
      return `<${n.name}>`
    case "Seq":
      return words(n.parts.map((p) => showPart(p, seen)))
    case "Gen": {
      // Replay with no values; a generator that branches on a value may throw.
      const parts: Array<string> = []
      try {
        const it = n.run()
        for (let r = it.next(); !r.done; r = it.next(undefined)) parts.push(showPart(r.value, seen))
      } catch {
        parts.push("…")
      }
      return words(parts)
    }
    case "Wrap":
      return words([show(n.open, seen), show(n.inner, seen), show(n.close, seen)])
    case "Choice":
      return `(${n.options.map((o) => show(o, seen)).join(" | ")})`
    case "Many": {
      const inner = show(n.inner, seen)
      const sep = show(n.sep, seen)
      if (sep === "") return `(${inner})${repetition(n)}`
      const rest = repetition({ min: Math.max(0, n.min - 1), max: n.max - 1 })
      const body = `${inner} (${sep} ${inner})${rest}`
      return n.min === 0 ? `(${body})?` : body
    }
    case "Optional":
      return `(${show(n.inner, seen)})?`
    case "Transform":
    case "Label":
      return show(n.inner, seen)
    case "Skip":
      return n.show ? show(n.inner, seen) : ""
    case "Suspend": {
      if (seen.has(n)) return n.name ?? "…"
      seen.add(n)
      const s = show(resolve(n), seen)
      seen.delete(n)
      return s
    }
  }
}

export const render = (g: Grammar<unknown>): string => show(g, new Set())

/** A short name for error messages: the regex or label name if there is one, else the rendering. */
export const describe = (g: Grammar<unknown>): string =>
  g.node._tag === "Regex" || g.node._tag === "Label" ? g.node.name : render(g)
