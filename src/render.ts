import { type Bounds, type Expr, type Grammar, type Node, type Pattern, resolve } from "./core.ts"

interface Ctx {
  readonly seen: Set<Node>
  // Binding id to its name in the enclosing gen's return, when it has one.
  readonly names: Map<number, string>
}

const repetition = ({ min, max }: Bounds): string => {
  if (max === Number.POSITIVE_INFINITY) return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
  return min === max ? `{${min}}` : `{${min},${max}}`
}

const words = (parts: ReadonlyArray<string>): string => parts.filter((p) => p !== "").join(" ")

const nameBindings = (p: Pattern, path: string | undefined, names: Map<number, string>): void => {
  switch (p._tag) {
    case "Ref":
      if (path !== undefined) names.set(p.id, path)
      return
    case "Const":
      return
    case "Object":
      for (const [key, field] of p.fields) {
        nameBindings(field, path === undefined ? key : `${path}.${key}`, names)
      }
      return
    case "Array":
      p.items.forEach((item, i) => {
        nameBindings(item, path === undefined ? String(i) : `${path}.${i}`, names)
      })
      return
  }
}

/** True when the rendering is more than one word at the top level, so a name needs to group it. */
const isLoose = (rendered: string): boolean => {
  let depth = 0
  let quoted = false
  for (let i = 0; i < rendered.length; i++) {
    const c = rendered[i]
    if (quoted) {
      if (c === "\\") i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === "(" || c === "{" || c === "<") depth++
    else if (c === ")" || c === "}" || (c === ">" && rendered[i - 1] !== "=")) depth--
    else if (c === " " && depth === 0) return true
  }
  return false
}

const showExpr = (e: Expr, names: Map<number, string>): string =>
  e._tag === "Ref" ? (names.get(e.id) ?? `$${e.id}`) : `${showExpr(e.object, names)}.${e.key}`

const show = (g: Grammar<any>, ctx: Ctx): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value === "" ? "" : JSON.stringify(n.value)
    case "Regex":
      return `<${n.name}>`
    case "Gen": {
      nameBindings(n.result, undefined, ctx.names)
      return words(
        n.steps.map((step) => {
          const inner = show(step.grammar, ctx)
          const name = step._tag === "Bind" ? ctx.names.get(step.id) : undefined
          if (name === undefined) return inner
          return isLoose(inner) ? `${name}:(${inner})` : `${name}:${inner}`
        }),
      )
    }
    case "Wrap":
      return words([show(n.open, ctx), show(n.inner, ctx), show(n.close, ctx)])
    case "Choice":
      return `(${n.options.map((o) => show(o, ctx)).join(" | ")})`
    case "Many": {
      const inner = show(n.inner, ctx)
      const sep = show(n.sep, ctx)
      if (sep === "") return `(${inner})${repetition(n)}`
      const rest = repetition({ min: Math.max(0, n.min - 1), max: n.max - 1 })
      const body = `${inner} (${sep} ${inner})${rest}`
      return n.min === 0 ? `(${body})?` : body
    }
    case "Optional":
      return `(${show(n.inner, ctx)})?`
    case "Transform":
    case "Label":
      return show(n.inner, ctx)
    case "Skip":
      return n.show ? show(n.inner, ctx) : ""
    case "Suspend": {
      if (ctx.seen.has(n)) return n.name ?? "…"
      ctx.seen.add(n)
      const s = show(resolve(n), ctx)
      ctx.seen.delete(n)
      return s
    }
    case "Match": {
      const cases = n.cases.map((c) => `${c.key} => ${show(c.grammar, ctx)}`)
      return `match(${showExpr(n.scrutinee, ctx.names)}){${cases.join(" | ")}}`
    }
    case "Dependent":
      return n.show(
        n.deps.map((d) => showExpr(d, ctx.names)),
        (inner) => show(inner, ctx),
      )
  }
}

export const render = (g: Grammar<any>): string => show(g, { seen: new Set(), names: new Map() })

/** A short name for error messages: the regex or label name if there is one, else the rendering. */
export const describe = (g: Grammar<any>): string =>
  g.node._tag === "Regex" || g.node._tag === "Label" ? g.node.name : render(g)
