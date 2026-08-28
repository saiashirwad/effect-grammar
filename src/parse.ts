import { Result } from "effect"

import { type Grammar, isField, type Part, resolve } from "./core.ts"
import { ParseError } from "./errors.ts"
import { describe } from "./render.ts"

type ParseValue = string | number | boolean | bigint | symbol | null | undefined | object

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

const runPart = (p: Part, s: State): ParseValue | typeof FAIL => go(isField(p) ? p.grammar : p, s)

const go = (g: Grammar<unknown>, s: State): ParseValue | typeof FAIL => {
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
    case "Seq": {
      const out = new Map<string, ParseValue>()
      for (const p of n.parts) {
        const v = runPart(p, s)
        if (v === FAIL) return FAIL
        if (isField(p)) out.set(p.name, v)
      }
      return n.parts.some(isField) ? Object.fromEntries(out) : undefined
    }
    case "Gen": {
      const it = n.run()
      const out = new Map<string, ParseValue>()
      let r = it.next()
      while (!r.done) {
        const p = r.value
        const v = runPart(p, s)
        if (v === FAIL) {
          it.return(undefined)
          return FAIL
        }
        if (isField(p)) {
          if (out.has(p.name)) {
            throw new Error(`gen: field "${p.name}" yielded twice — use many() to repeat`)
          }
          out.set(p.name, v)
        }
        r = it.next(v)
      }
      return r.value ?? Object.fromEntries(out)
    }
    case "Wrap": {
      if (go(n.open, s) === FAIL) return FAIL
      const v = go(n.inner, s)
      if (v === FAIL) return FAIL
      return go(n.close, s) === FAIL ? FAIL : v
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
      const out: Array<ParseValue> = []
      let mark = s.pos
      while (out.length < n.max) {
        const v = go(n.inner, s)
        if (v === FAIL) break
        if (s.pos === mark) throw new Error("many: element matched without consuming input")
        out.push(v)
        mark = s.pos
        if (go(n.sep, s) === FAIL) break
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
      if (n.is?.(b) === false) {
        s.pos = start
        return failAt(s, n.name ?? describe(n.inner))
      }
      return b
    }
    case "Skip":
      return go(n.inner, s) === FAIL ? FAIL : undefined
    case "Label": {
      const start = s.pos
      // Expectations already recorded here belong to sibling branches; only the inner ones collapse.
      const siblings = s.furthest === start ? [...s.expected] : []
      const v = go(n.inner, s)
      if (v === FAIL && s.furthest === start) s.expected = new Set([...siblings, n.name])
      return v
    }
    case "Suspend":
      return go(resolve(n), s)
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
  const v = go(grammar, s)
  if (v !== FAIL && s.pos === input.length) {
    // SAFETY: go only returns the grammar's parsed value when it reaches the end successfully.
    return Result.succeed(v as A)
  }
  if (v !== FAIL) failAt(s, "end of input")
  return Result.fail(toError(s))
}
