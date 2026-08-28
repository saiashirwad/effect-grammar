import { Result } from "effect"

import { type Grammar, isField, type Part, resolve } from "./core.ts"
import { ParseError } from "./errors.ts"
import { describe } from "./render.ts"

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
}

const FAIL: unique symbol = Symbol.for("effect-grammar/fail")
type Res<A> = A | typeof FAIL

const failAt = (s: State, expected: string): typeof FAIL => {
  if (s.pos > s.furthest) {
    s.furthest = s.pos
    s.expected = new Set([expected])
  } else if (s.pos === s.furthest) {
    s.expected.add(expected)
  }
  return FAIL
}

const runPart = (p: Part, s: State): Res<unknown> => go(isField(p) ? p.grammar : p, s)

const go = (g: Grammar<unknown>, s: State): Res<unknown> => {
  const n = g.node
  switch (n._tag) {
    case "Literal": {
      if (!s.input.startsWith(n.value, s.pos)) return failAt(s, JSON.stringify(n.value))
      s.pos += n.value.length
      return undefined
    }
    case "Regex": {
      const m = n.re.exec(s.input.slice(s.pos))
      if (m === null || m.index !== 0) return failAt(s, n.name)
      s.pos += m[0].length
      return m[0]
    }
    case "Seq": {
      const out: Record<string, unknown> = {}
      let hasField = false
      for (const p of n.parts) {
        const v = runPart(p, s)
        if (v === FAIL) return FAIL
        if (isField(p)) {
          out[p.name] = v
          hasField = true
        }
      }
      return hasField ? out : undefined
    }
    case "Gen": {
      const it = n.run()
      const out: Record<string, unknown> = {}
      let r = it.next()
      while (!r.done) {
        const p = r.value
        const v = runPart(p, s)
        if (v === FAIL) {
          it.return?.(undefined)
          return FAIL
        }
        if (isField(p)) {
          if (p.name in out) {
            throw new Error(`gen: field "${p.name}" yielded twice — use many() to repeat`)
          }
          out[p.name] = v
        }
        r = it.next(v)
      }
      return r.value === undefined ? out : r.value
    }
    case "Wrap": {
      if (go(n.open, s) === FAIL) return FAIL
      const v = go(n.inner, s)
      if (v === FAIL) return FAIL
      if (go(n.close, s) === FAIL) return FAIL
      return v
    }
    case "Choice": {
      const start = s.pos
      for (const o of n.options) {
        const v = go(o, s)
        if (v !== FAIL) return v
        s.pos = start
      }
      return FAIL
    }
    case "Many": {
      const out: Array<unknown> = []
      while (out.length < n.max) {
        const mark = s.pos
        const v = go(n.inner, s)
        if (v === FAIL) {
          s.pos = mark
          break
        }
        if (s.pos === mark) throw new Error("many: inner grammar matched without consuming input")
        out.push(v)
      }
      return out.length < n.min ? FAIL : out
    }
    case "SepBy": {
      const out: Array<unknown> = []
      let mark = s.pos
      let v = go(n.inner, s)
      while (v !== FAIL && out.length < n.max) {
        out.push(v)
        mark = s.pos
        if (go(n.sep, s) === FAIL) break
        if (s.pos === mark) throw new Error("sepBy: separator matched without consuming input")
        v = go(n.inner, s)
      }
      s.pos = mark
      return out.length < n.min ? FAIL : out
    }
    case "Optional": {
      const mark = s.pos
      const v = go(n.inner, s)
      if (v !== FAIL) return v
      s.pos = mark
      return undefined
    }
    case "Transform": {
      const start = s.pos
      const v = go(n.inner, s)
      if (v === FAIL) return FAIL
      const b = n.decode(v)
      if (n.is !== undefined && !n.is(b)) {
        s.pos = start
        return failAt(s, n.name ?? describe(n.inner))
      }
      return b
    }
    case "Const":
      return go(n.inner, s) === FAIL ? FAIL : n.value
    case "Skip":
      return go(n.inner, s) === FAIL ? FAIL : undefined
    case "Label": {
      const start = s.pos
      const v = go(n.inner, s)
      if (v !== FAIL) return v
      if (s.furthest === start) s.expected = new Set([n.name])
      return FAIL
    }
    case "Suspend":
      return go(resolve(n), s)
  }
}

const lineColumn = (input: string, pos: number): { line: number; column: number } => {
  let line = 1
  let column = 1
  for (let i = 0; i < pos; i++) {
    if (input.charCodeAt(i) === 10) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

const toError = (s: State): ParseError =>
  new ParseError({
    pos: s.furthest,
    ...lineColumn(s.input, s.furthest),
    expected: [...s.expected],
    found: s.input[s.furthest],
  })

export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> => {
  const s: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const v = go(grammar, s)
  if (v === FAIL) return Result.fail(toError(s))
  if (s.pos < input.length) {
    failAt(s, "end of input")
    return Result.fail(toError(s))
  }
  return Result.succeed(v as A)
}
