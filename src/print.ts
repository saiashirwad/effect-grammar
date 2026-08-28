import { Equal, Result } from "effect"

import { type Grammar, isField, type Part, resolve } from "./core.ts"
import { PrintError } from "./errors.ts"
import { describe } from "./render.ts"

class PrintFail {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

const printFail = (message: string): never => {
  throw new PrintFail(message)
}

export const preview = (u: unknown): string => {
  try {
    return JSON.stringify(u) ?? String(u)
  } catch {
    return String(u)
  }
}

const printPart = (p: Part, value: Record<string, unknown>): string =>
  isField(p) ? out(p.grammar, value[p.name]) : out(p, undefined)

const out = (g: Grammar<unknown>, value: unknown): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value
    case "Regex": {
      if (typeof value !== "string") {
        return printFail(`${n.name}: expected a string, got ${preview(value)}`)
      }
      const anchored = new RegExp(`^(?:${n.re.source})$`, n.re.flags)
      return anchored.test(value)
        ? value
        : printFail(`${n.name}: ${JSON.stringify(value)} does not match /${n.re.source}/`)
    }
    case "Seq":
      return n.parts.map((p) => printPart(p, value as Record<string, unknown>)).join("")
    case "Gen": {
      const it = n.run()
      let acc = ""
      let r = it.next()
      while (!r.done) {
        const p = r.value
        acc += printPart(p, value as Record<string, unknown>)
        r = it.next(isField(p) ? (value as Record<string, unknown>)[p.name] : undefined)
      }
      return acc
    }
    case "Wrap":
      return out(n.open, undefined) + out(n.inner, value) + out(n.close, undefined)
    case "Choice": {
      const reasons: Array<string> = []
      for (const o of n.options) {
        try {
          return out(o, value)
        } catch (e) {
          if (!(e instanceof PrintFail)) throw e
          reasons.push(e.message)
        }
      }
      return printFail(`no choice branch accepts ${preview(value)}:\n  ${reasons.join("\n  ")}`)
    }
    case "Many":
    case "SepBy": {
      if (!Array.isArray(value)) return printFail(`expected an array, got ${preview(value)}`)
      if (value.length < n.min || value.length > n.max) {
        const range =
          n.max === Number.POSITIVE_INFINITY ? `at least ${n.min}` : `${n.min}..${n.max}`
        return printFail(`expected ${range} items, got ${value.length}`)
      }
      const sep = n._tag === "SepBy" ? out(n.sep, undefined) : ""
      return value.map((v) => out(n.inner, v)).join(sep)
    }
    case "Optional":
      return value === undefined ? "" : out(n.inner, value)
    case "Transform":
      if (n.is !== undefined && !n.is(value)) {
        return printFail(`${n.name ?? describe(n.inner)}: rejected ${preview(value)}`)
      }
      return out(n.inner, n.encode(value))
    case "Const":
      return Equal.equals(value, n.value)
        ? out(n.inner, undefined)
        : printFail(`expected ${preview(n.value)}, got ${preview(value)}`)
    case "Skip":
      return out(n.inner, n.printAs)
    case "Label":
      return out(n.inner, value)
    case "Suspend":
      return out(resolve(n), value)
  }
}

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> => {
  try {
    return Result.succeed(out(grammar, value))
  } catch (e) {
    if (e instanceof PrintFail) return Result.fail(new PrintError({ message: e.message }))
    throw e
  }
}
