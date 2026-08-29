import { Equal, Option, Predicate, Result, Schema } from "effect"

import { type Grammar, type Pattern, resolve, type Step, type Value } from "./core.ts"
import { caseFor, child, type Env, evaluate, keyCandidates, lookup } from "./env.ts"
import { preview, PrintError } from "./errors.ts"
import { describe, describeStep, render } from "./render.ts"

class Failure {
  readonly reason: () => string
  constructor(reason: () => string) {
    this.reason = reason
  }
}

const fail = (reason: () => string) => new Failure(reason)

const unify = (p: Pattern, value: Value, values: Map<number, Value>): Failure | undefined => {
  switch (p._tag) {
    case "Ref":
      values.set(p.id, value)
      return undefined
    case "Const":
      return Equal.equals(value, p.value)
        ? undefined
        : fail(() => `expected ${preview(p.value)}, got ${preview(value)}`)
    case "Object": {
      if (!Predicate.isObject(value)) return fail(() => `expected an object, got ${preview(value)}`)
      for (const [key, field] of p.fields) {
        const r = unify(field, Predicate.hasProperty(value, key) ? value[key] : undefined, values)
        if (r !== undefined) return r
      }
      return undefined
    }
    case "Array": {
      if (!Array.isArray(value)) return fail(() => `expected an array, got ${preview(value)}`)
      if (value.length !== p.items.length) {
        return fail(() => `expected ${p.items.length} items, got ${value.length}`)
      }
      for (const [i, item] of p.items.entries()) {
        const r = unify(item, value[i], values)
        if (r !== undefined) return r
      }
      return undefined
    }
  }
}

export const recoverable = (g: Grammar<any>): ReadonlyArray<number> => {
  const n = g.node
  switch (n._tag) {
    case "Label":
    case "Wrap":
    case "Transform":
      return recoverable(n.inner)
    case "Match":
      return n.scrutinee._tag === "Ref" ? [n.scrutinee.id] : []
    case "Dependent":
      return n.recover === undefined ? [] : n.deps.flatMap((d) => (d._tag === "Ref" ? [d.id] : []))
    default:
      return []
  }
}

type Candidates = Map<number, ReadonlyArray<Value>>

const hidden = (env: Env, candidates: Candidates, id: number) =>
  Option.isNone(lookup(env, id)) && !candidates.has(id)

const recover = (g: Grammar<any>, value: Value, env: Env, candidates: Candidates): void => {
  const n = g.node
  switch (n._tag) {
    case "Label":
    case "Wrap":
      return recover(n.inner, value, env, candidates)
    case "Transform":
      if (n.is?.(value) === false) return
      return recover(n.inner, n.encode(value), env, candidates)
    case "Match": {
      const e = n.scrutinee
      if (e._tag !== "Ref" || !hidden(env, candidates, e.id)) return
      for (const c of n.cases) {
        if (!(out(c.grammar, value, env) instanceof Failure)) {
          candidates.set(e.id, keyCandidates(c.key))
          return
        }
      }
      return
    }
    case "Dependent": {
      const values = n.recover?.(value)
      if (values === undefined) return
      n.deps.forEach((d, i) => {
        if (d._tag === "Ref" && i < values.length && hidden(env, candidates, d.id)) {
          candidates.set(d.id, [values[i]])
        }
      })
    }
  }
}

const printBind = (
  step: Extract<Step, { _tag: "Bind" }>,
  index: number,
  env: Env,
  candidates: Candidates,
) => {
  if (env.values.has(step.id)) return out(step.grammar, env.values.get(step.id), env)
  const where = describeStep(step, index)
  const cs = candidates.get(step.id)
  if (cs === undefined) {
    return fail(() => `${where} is not in the value and no later step recovers it`)
  }
  const reasons: Array<() => string> = []
  for (const c of cs) {
    const r = out(step.grammar, c, env)
    if (!(r instanceof Failure)) {
      env.values.set(step.id, c)
      return r
    }
    reasons.push(r.reason)
  }
  return fail(
    () =>
      `${where} accepts none of the recovered values ${cs.map(preview).join(", ")}:\n  ${reasons.map((r) => r()).join("\n  ")}`,
  )
}

const out = <A>(g: Grammar<A>, value: A, env: Env | undefined): string | Failure => {
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
    case "Gen": {
      const local = child(env)
      const u = unify(n.result, value, local.values)
      if (u !== undefined) return u
      const candidates: Candidates = new Map()
      if (n.steps.some((step) => step._tag === "Bind" && !local.values.has(step.id))) {
        for (const step of n.steps.toReversed()) {
          if (step._tag === "Bind" && local.values.has(step.id)) {
            recover(step.grammar, local.values.get(step.id), local, candidates)
          }
        }
      }
      let acc = ""
      for (const [i, step] of n.steps.entries()) {
        const r =
          step._tag === "Silent"
            ? out(step.grammar, undefined, local)
            : printBind(step, i, local, candidates)
        if (r instanceof Failure) return r
        acc += r
      }
      return acc
    }
    case "Wrap": {
      const open = out(n.open, undefined, env)
      if (open instanceof Failure) return open
      const inner = out(n.inner, value, env)
      if (inner instanceof Failure) return inner
      const close = out(n.close, undefined, env)
      if (close instanceof Failure) return close
      return open + inner + close
    }
    case "Choice": {
      const reasons: Array<() => string> = []
      for (const o of n.options) {
        const r = out(o, value, env)
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
      const sep = out(n.sep, undefined, env)
      if (sep instanceof Failure) return sep
      let acc = ""
      for (let i = 0; i < value.length; i++) {
        const r = out(n.inner, value[i], env)
        if (r instanceof Failure) return r
        acc += i === 0 ? r : sep + r
      }
      return acc
    }
    case "Optional":
      return value === undefined ? "" : out(n.inner, value, env)
    case "Transform":
      if (n.is?.(value) === false) {
        return fail(() => `expected ${n.name ?? describe(n.inner)}, got ${preview(value)}`)
      }
      return out(n.inner, n.encode(value), env)
    case "Skip":
      return out(n.inner, n.printAs, env)
    case "Label":
      return out(n.inner, value, env)
    case "Suspend":
      return out(resolve(n), value, env)
    case "Match": {
      const k = evaluate(n.scrutinee, env)
      if (Option.isNone(k)) return fail(() => "match: the ref it branches on is not bound")
      const c = caseFor(n.cases, k.value)
      if (c === undefined) return fail(() => `match: no case for ${preview(k.value)}`)
      return out(c.grammar, value, env)
    }
    case "Dependent": {
      const values = Option.all(n.deps.map((d) => evaluate(d, env)))
      if (Option.isNone(values)) return fail(() => "a ref this grammar depends on is not bound")
      const chosen = n.select(values.value)
      if (chosen === undefined) {
        return fail(
          () => `expected ${n.show(values.value.map(preview), render)}, got ${preview(value)}`,
        )
      }
      return out(chosen, value, env)
    }
  }
}

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> => {
  const r = out(grammar, value, undefined)
  return r instanceof Failure
    ? Result.fail(new PrintError({ message: r.reason() }))
    : Result.succeed(r)
}
