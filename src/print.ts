import { Result, Schema } from "effect"

import { type Fields, type Grammar, isField, type Part, resolve } from "./core.ts"
import { preview, PrintError } from "./errors.ts"
import { describe } from "./render.ts"

class Failure {
  readonly reason: () => string
  constructor(reason: () => string) {
    this.reason = reason
  }
}

const fail = (reason: () => string): Failure => new Failure(reason)

type PrintFields = Fields<Part>

const printPart = <A>(p: Part, value: A): string | Failure => {
  if (isField(p)) {
    // SAFETY: Seq and Gen only pass field bags shaped by the grammar's parts.
    const fields = value as PrintFields
    return out(p.grammar, fields[p.name])
  }
  return out(p, undefined)
}

const out = <A>(g: Grammar<A>, value: A): string | Failure => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value
    case "Regex":
      if (!Schema.is(Schema.String)(value)) {
        return fail(() => `${n.name}: expected a string, got ${preview(value)}`)
      }
      if (!n.whole.test(value)) {
        return fail(() => `${n.name}: ${JSON.stringify(value)} does not match /${n.re.source}/`)
      }
      return value
    case "Seq": {
      let acc = ""
      for (const p of n.parts) {
        const r = printPart(p, value)
        if (r instanceof Failure) return r
        acc += r
      }
      return acc
    }
    case "Gen": {
      // SAFETY: gen values are the field bag produced by the surrounding grammar.
      const fields = value as PrintFields
      const it = n.run()
      let acc = ""
      let r = it.next()
      while (!r.done) {
        const p = r.value
        const s = printPart(p, fields)
        if (s instanceof Failure) return s
        acc += s
        r = it.next(isField(p) ? fields[p.name] : undefined)
      }
      return acc
    }
    case "Wrap": {
      const open = out(n.open, undefined)
      if (open instanceof Failure) return open
      const inner = out(n.inner, value)
      if (inner instanceof Failure) return inner
      const close = out(n.close, undefined)
      if (close instanceof Failure) return close
      return open + inner + close
    }
    case "Choice": {
      const reasons: Array<() => string> = []
      for (const o of n.options) {
        const r = out(o, value)
        if (!(r instanceof Failure)) return r
        reasons.push(r.reason)
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
      const sep = out(n.sep, undefined)
      if (sep instanceof Failure) return sep
      let acc = ""
      for (let i = 0; i < value.length; i++) {
        const r = out(n.inner, value[i])
        if (r instanceof Failure) return r
        acc += i === 0 ? r : sep + r
      }
      return acc
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
  const r = out(grammar, value)
  return r instanceof Failure
    ? Result.fail(new PrintError({ message: r.reason() }))
    : Result.succeed(r)
}
