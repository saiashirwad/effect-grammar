import { Result } from "effect"

import {
  type Grammar,
  type GrammarInternal,
  nodeOf,
  resolve,
  unsafeToNever,
  type Value,
} from "./core.ts"
import { bind, caseFor, evaluate, type Frame, frame, isCount, materialize, Unbound } from "./env.ts"
import { exceptionMessage, ParseError, preview } from "./errors.ts"
import { describe } from "./render.ts"

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
}

const Fail = Symbol("effect-grammar/ParseFail")

const failAt = (state: State, expected: string): typeof Fail => {
  if (state.pos > state.furthest) {
    state.furthest = state.pos
    state.expected = new Set([expected])
  } else if (state.pos === state.furthest) {
    state.expected.add(expected)
  }
  return Fail
}

const go = (
  grammar: GrammarInternal,
  state: State,
  env: Frame | undefined,
): Value | typeof Fail => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal": {
      if (state.input.startsWith(node.value, state.pos)) {
        state.pos += node.value.length
        return undefined
      }
      // Failure path only: report at the first mismatching character.
      const end = state.pos + node.value.length
      let current = state.pos
      while (current < end && state.input[current] === node.value[current - state.pos]) current++
      state.pos = current
      return failAt(state, JSON.stringify(node.value))
    }
    case "Regex": {
      node.re.lastIndex = state.pos
      const match = node.re.exec(state.input)
      if (match === null) return failAt(state, node.name)
      state.pos += match[0].length
      return match[0]
    }
    case "Gen": {
      const local = frame(node.scope, node.slotCount, env)
      for (const step of node.steps) {
        const value = go(step.grammar, state, local)
        if (value === Fail) return Fail
        if (step._tag === "Bind") bind(local, step.slot, value)
      }
      const value = materialize(node.result, local)
      return value === Unbound ? failAt(state, "a bound generator result") : value
    }
    case "Wrap": {
      if (go(node.open, state, env) === Fail) return Fail
      const value = go(node.inner, state, env)
      if (value === Fail) return Fail
      return go(node.close, state, env) === Fail ? Fail : value
    }
    case "Choice": {
      const start = state.pos
      for (const option of node.options) {
        const value = go(option, state, env)
        if (value !== Fail) return value
        state.pos = start
      }
      return Fail
    }
    case "Many": {
      const values: Array<Value> = []
      let mark = state.pos
      while (values.length < node.max) {
        const value = go(node.inner, state, env)
        if (value === Fail) break
        if (state.pos === mark) return failAt(state, "a repetition element that consumes input")
        values.push(value)
        mark = state.pos
        if (go(node.sep, state, env) === Fail) break
      }
      state.pos = mark
      return values.length < node.min ? Fail : values
    }
    case "Optional": {
      const mark = state.pos
      const value = go(node.inner, state, env)
      if (value !== Fail) return value
      state.pos = mark
      return undefined
    }
    case "Transform": {
      const start = state.pos
      const value = go(node.inner, state, env)
      if (value === Fail) return Fail
      try {
        const decoded = node.decode(unsafeToNever(value))
        if (Result.isFailure(decoded)) {
          state.pos = start
          return failAt(state, decoded.failure.message)
        }
        if (node.is?.(unsafeToNever(decoded.success)) === false) {
          state.pos = start
          return failAt(state, node.name ?? describe(node.inner))
        }
        return decoded.success
      } catch (error) {
        state.pos = start
        return failAt(state, `${node.name ?? describe(node.inner)}: ${exceptionMessage(error)}`)
      }
    }
    case "Skip":
      return go(node.inner, state, env) === Fail ? Fail : undefined
    case "Label": {
      const start = state.pos
      const siblings = state.furthest === start ? [...state.expected] : []
      const value = go(node.inner, state, env)
      if (value === Fail && state.furthest === start) {
        state.expected = new Set([...siblings, node.name])
      }
      return value
    }
    case "Suspend":
      return go(resolve(node), state, env)
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return failAt(state, "a bound match ref")
      const matchCase = caseFor(node.cases, key)
      if (matchCase === undefined) return failAt(state, `a match case for ${preview(key)}`)
      return go(matchCase.grammar, state, env)
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return failAt(state, "a bound take count")
      if (!isCount(count)) return failAt(state, `<char>{${preview(count)}}`)
      if (state.input.length - state.pos < count) {
        return failAt(state, `${count} chars`)
      }
      const value = state.input.slice(state.pos, state.pos + count)
      state.pos += count
      return value
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return failAt(state, "a bound repeat count")
      if (!isCount(count)) return failAt(state, `a non-negative repeat count`)
      const values: Array<Value> = []
      for (let index = 0; index < count; index++) {
        const mark = state.pos
        const value = go(node.inner, state, env)
        if (value === Fail) return Fail
        if (state.pos === mark) return failAt(state, "a repetition element that consumes input")
        values.push(value)
      }
      return values
    }
  }
}

const toError = (state: State): ParseError => {
  const before = state.input.slice(0, state.furthest)
  const code = state.input.codePointAt(state.furthest)
  return new ParseError({
    pos: state.furthest,
    line: before.split("\n").length,
    column: before.length - before.lastIndexOf("\n"),
    expected: [...state.expected],
    found: code === undefined ? undefined : String.fromCodePoint(code),
  })
}

export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> => {
  const state: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const value = go(grammar, state, undefined)
  if (value !== Fail && state.pos === input.length) {
    // SAFETY: interpreting Grammar<A> preserves its output type across every node.
    return Result.succeed(value as A)
  }
  if (value !== Fail) failAt(state, "end of input")
  return Result.fail(toError(state))
}
