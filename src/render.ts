import { type Bounds, type Grammar, isField, type Node, type Part, resolve } from "./core.ts"

const repetition = (b: Bounds): string => {
  if (b.max === Number.POSITIVE_INFINITY) {
    return b.min === 0 ? "*" : b.min === 1 ? "+" : `{${b.min},}`
  }
  return b.min === b.max ? `{${b.min}}` : `{${b.min},${b.max}}`
}

const joinShown = (parts: ReadonlyArray<string>): string => parts.filter((p) => p !== "").join(" ")

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
      return joinShown(n.parts.map((p) => showPart(p, seen)))
    case "Gen": {
      const parts: Array<string> = []
      try {
        const it = n.run()
        let r = it.next()
        while (!r.done) {
          parts.push(showPart(r.value, seen))
          r = it.next(undefined)
        }
      } catch {
        parts.push("…")
      }
      return joinShown(parts)
    }
    case "Wrap":
      return joinShown([show(n.open, seen), show(n.inner, seen), show(n.close, seen)])
    case "Choice":
      return `(${n.options.map((o) => show(o, seen)).join(" | ")})`
    case "Many":
      return `(${show(n.inner, seen)})${repetition(n)}`
    case "SepBy": {
      const inner = show(n.inner, seen)
      const sep = show(n.sep, seen)
      const rest = repetition({
        min: Math.max(0, n.min - 1),
        max: n.max === Number.POSITIVE_INFINITY ? n.max : n.max - 1,
      })
      const body = `${inner} (${joinShown([sep, inner])})${rest}`
      return n.min === 0 ? `(${body})?` : body
    }
    case "Optional":
      return `(${show(n.inner, seen)})?`
    case "Transform":
    case "Const":
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

export const describe = (g: Grammar<unknown>): string => {
  const n = g.node
  if (n._tag === "Regex") return n.name
  if (n._tag === "Label") return n.name
  return render(g)
}
