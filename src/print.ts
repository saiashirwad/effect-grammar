import { Result, Schema } from "effect"

import { type Grammar, isField, type Part, resolve } from "./core.ts"
import { preview, PrintError } from "./errors.ts"
import { describe } from "./render.ts"

const isPrintError = Schema.is(PrintError)

const fail = (message: string): never => {
  throw new PrintError({ message })
}

const printPart = (p: Part, value: Record<string, unknown>): string =>
  isField(p) ? out(p.grammar, value[p.name]) : out(p, undefined)

const out = (g: Grammar<unknown>, value: unknown): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value
    case "Regex": {
      if (typeof value !== "string")
        return fail(`${n.name}: expected a string, got ${preview(value)}`)
      const whole = new RegExp(`^(?:${n.re.source})$`, n.re.flags.replace("y", ""))
      if (!whole.test(value)) {
        return fail(`${n.name}: ${JSON.stringify(value)} does not match /${n.re.source}/`)
      }
      return value
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
          if (!isPrintError(e)) throw e
          reasons.push(e.message)
        }
      }
      return fail(`no choice branch accepts ${preview(value)}:\n  ${reasons.join("\n  ")}`)
    }
    case "Many": {
      if (!Array.isArray(value)) return fail(`expected an array, got ${preview(value)}`)
      if (value.length < n.min || value.length > n.max) {
        const range =
          n.max === Number.POSITIVE_INFINITY ? `at least ${n.min}` : `${n.min}..${n.max}`
        return fail(`expected ${range} items, got ${value.length}`)
      }
      return value.map((v) => out(n.inner, v)).join(out(n.sep, undefined))
    }
    case "Optional":
      return value === undefined ? "" : out(n.inner, value)
    case "Transform":
      if (n.is?.(value) === false) {
        return fail(`expected ${n.name ?? describe(n.inner)}, got ${preview(value)}`)
      }
      return out(n.inner, n.encode(value))
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
    if (isPrintError(e)) return Result.fail(e)
    throw e
  }
}
