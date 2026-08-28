import { Result, Schema } from "effect"

import { type Fields, type Grammar, isField, type Part, resolve } from "./core.ts"
import { preview, PrintError } from "./errors.ts"
import { describe } from "./render.ts"

const isString = Schema.is(Schema.String)

/**
 * Internal failure. Choice backtracks by catching these, so the message is a thunk:
 * only the failure that escapes `print` pays for rendering its value.
 */
class Failure {
  readonly reason: () => string
  constructor(reason: () => string) {
    this.reason = reason
  }
}

const fail = (reason: () => string): never => {
  throw new Failure(reason)
}

type PrintFields = Fields<Part>

const printPart = <A>(p: Part, value: A): string => {
  if (isField(p)) {
    // SAFETY: Seq and Gen only pass field bags shaped by the grammar's parts.
    const fields = value as PrintFields
    return out(p.grammar, fields[p.name])
  }
  return out(p, undefined)
}

const out = <A>(g: Grammar<A>, value: A): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value
    case "Regex":
      if (!isString(value)) {
        return fail(() => `${n.name}: expected a string, got ${preview(value)}`)
      }
      if (!n.whole.test(value)) {
        return fail(() => `${n.name}: ${JSON.stringify(value)} does not match /${n.re.source}/`)
      }
      return value
    case "Seq":
      return n.parts.map((p) => printPart(p, value)).join("")
    case "Gen": {
      // SAFETY: gen values are the field bag produced by the surrounding grammar.
      const fields = value as PrintFields
      const it = n.run()
      let acc = ""
      let r = it.next()
      while (!r.done) {
        const p = r.value
        acc += printPart(p, fields)
        r = it.next(isField(p) ? fields[p.name] : undefined)
      }
      return acc
    }
    case "Wrap":
      return out(n.open, undefined) + out(n.inner, value) + out(n.close, undefined)
    case "Choice": {
      const reasons: Array<() => string> = []
      for (const o of n.options) {
        try {
          return out(o, value)
        } catch (e) {
          if (!(e instanceof Failure)) throw e
          reasons.push(e.reason)
        }
      }
      return fail(
        () =>
          `no choice branch accepts ${preview(value)}:\n  ${reasons.map((r) => r()).join("\n  ")}`,
      )
    }
    case "Many": {
      if (!Array.isArray(value)) return fail(() => `expected an array, got ${preview(value)}`)
      if (value.length < n.min || value.length > n.max) {
        const range =
          n.max === Number.POSITIVE_INFINITY ? `at least ${n.min}` : `${n.min}..${n.max}`
        return fail(() => `expected ${range} items, got ${value.length}`)
      }
      return value.map((v) => out(n.inner, v)).join(out(n.sep, undefined))
    }
    case "Optional":
      return value === undefined ? "" : out(n.inner, value)
    case "Transform":
      if (n.is?.(value) === false) {
        return fail(() => `expected ${n.name ?? describe(n.inner)}, got ${preview(value)}`)
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
    if (e instanceof Failure) return Result.fail(new PrintError({ message: e.reason() }))
    throw e
  }
}
