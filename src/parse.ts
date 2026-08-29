import { Result } from "effect"

import { type Grammar, resolve, type Value } from "./core.ts"
import { child, type Env, evaluateOrThrow, keyOf, materialize } from "./env.ts"
import { ParseError, preview } from "./errors.ts"
import { describe, render } from "./render.ts"

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
}

const FAIL = Symbol.for("effect-grammar/fail")

const failAt = (s: State, expected: string): typeof FAIL => {
  if (s.pos > s.furthest) {
    s.furthest = s.pos
    s.expected = new Set([expected])
  } else if (s.pos === s.furthest) {
    s.expected.add(expected)
  }
  return FAIL
}

const go = (g: Grammar<any>, s: State, env: Env | undefined): Value | typeof FAIL => {
  const n = g.node
  switch (n._tag) {
    case "Literal": {
      if (!s.input.startsWith(n.value, s.pos)) return failAt(s, JSON.stringify(n.value))
      s.pos += n.value.length
      return undefined
    }
    case "Regex": {
      n.re.lastIndex = s.pos
      const m = n.re.exec(s.input)
      if (m === null) return failAt(s, n.name)
      s.pos += m[0].length
      return m[0]
    }
    case "Gen": {
      const local = child(env)
      for (const step of n.steps) {
        const v = go(step.grammar, s, local)
        if (v === FAIL) return FAIL
        if (step._tag === "Bind") local.values.set(step.id, v)
      }
      return materialize(n.result, local)
    }
    case "Wrap": {
      if (go(n.open, s, env) === FAIL) return FAIL
      const v = go(n.inner, s, env)
      if (v === FAIL) return FAIL
      return go(n.close, s, env) === FAIL ? FAIL : v
    }
    case "Choice": {
      const start = s.pos
      for (const o of n.options) {
        const v = go(o, s, env)
        if (v !== FAIL) return v
        s.pos = start
      }
      return FAIL
    }
    case "Many": {
      const out: Array<Value> = []
      let mark = s.pos
      while (out.length < n.max) {
        const v = go(n.inner, s, env)
        if (v === FAIL) break
        if (s.pos === mark) throw new Error("many: element matched without consuming input")
        out.push(v)
        mark = s.pos
        if (go(n.sep, s, env) === FAIL) break
      }
      s.pos = mark
      return out.length < n.min ? FAIL : out
    }
    case "Optional": {
      const mark = s.pos
      const v = go(n.inner, s, env)
      if (v !== FAIL) return v
      s.pos = mark
      return undefined
    }
    case "Transform": {
      const start = s.pos
      const v = go(n.inner, s, env)
      if (v === FAIL) return FAIL
      const b = n.decode(v)
      if (n.is?.(b) === false) {
        s.pos = start
        return failAt(s, n.name ?? describe(n.inner))
      }
      return b
    }
    case "Skip":
      return go(n.inner, s, env) === FAIL ? FAIL : undefined
    case "Label": {
      const start = s.pos
      // Expectations already recorded here belong to sibling branches; only the inner ones collapse.
      const siblings = s.furthest === start ? [...s.expected] : []
      const v = go(n.inner, s, env)
      if (v === FAIL && s.furthest === start) s.expected = new Set([...siblings, n.name])
      return v
    }
    case "Suspend":
      return go(resolve(n), s, env)
    case "Match": {
      const k = evaluateOrThrow(n.scrutinee, env)
      const c = n.cases.find((c) => c.key === keyOf(k))
      if (c === undefined) return failAt(s, `a match case for ${preview(k)}`)
      return go(c.grammar, s, env)
    }
    case "Dependent": {
      const values = n.deps.map((d) => evaluateOrThrow(d, env))
      const chosen = n.select(values)
      if (chosen === undefined) return failAt(s, n.show(values.map(preview), render))
      return go(chosen, s, env)
    }
  }
}

const toError = (s: State) => {
  const before = s.input.slice(0, s.furthest)
  return new ParseError({
    pos: s.furthest,
    line: before.split("\n").length,
    column: before.length - before.lastIndexOf("\n"),
    expected: [...s.expected],
    found: s.input[s.furthest],
  })
}

export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> => {
  const s: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const v = go(grammar, s, undefined)
  if (v !== FAIL && s.pos === input.length) {
    // SAFETY: go only returns the grammar's parsed value when it reaches the end successfully.
    return Result.succeed(v as A)
  }
  if (v !== FAIL) failAt(s, "end of input")
  return Result.fail(toError(s))
}
