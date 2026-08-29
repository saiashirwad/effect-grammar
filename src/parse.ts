import { Option, Result } from "effect"

import {
  assertClosed,
  freeScopesOf,
  type Grammar,
  type GrammarInternal,
  nodeOf,
  resolve,
  type ScopeId,
  type Value,
} from "./core.ts"
import { bind, caseFor, evaluate, frame, type Frame, isCount, materialize } from "./env.ts"
import { exceptionMessage, ParseError, preview } from "./errors.ts"
import { describe, render } from "./render.ts"

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
}

const Fail = Symbol("effect-grammar/ParseFail")

const unsafeToNever = (value: Value): never => {
  // SAFETY: erased Node callbacks accept the runtime value produced for that node.
  return value as never
}

const failAt = (state: State, expected: string): typeof Fail => {
  if (state.pos > state.furthest) {
    state.furthest = state.pos
    state.expected = new Set([expected])
  } else if (state.pos === state.furthest) {
    state.expected.add(expected)
  }
  return Fail
}

const hasScope = (env: Frame | undefined, scope: ScopeId): boolean => {
  for (let current = env; current !== undefined; current = current.parent) {
    if (current.scope === scope) return true
  }
  return false
}

const refsAvailable = (grammar: GrammarInternal, env: Frame | undefined): boolean => {
  for (const scope of freeScopesOf(grammar)) if (!hasScope(env, scope)) return false
  return true
}

const go = (
  grammar: GrammarInternal,
  state: State,
  env: Frame | undefined,
): Value | typeof Fail => {
  if (!refsAvailable(grammar, env)) return failAt(state, "a grammar without unresolved refs")

  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal": {
      let offset = 0
      while (
        offset < node.value.length &&
        state.pos + offset < state.input.length &&
        state.input[state.pos + offset] === node.value[offset]
      ) {
        offset++
      }
      if (offset !== node.value.length) {
        state.pos += offset
        return failAt(state, JSON.stringify(node.value))
      }
      state.pos += node.value.length
      return undefined
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
      return Option.isNone(value) ? failAt(state, "a bound generator result") : value.value
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
        if (node.is?.(unsafeToNever(decoded)) === false) {
          state.pos = start
          return failAt(state, node.name ?? describe(node.inner))
        }
        return decoded
      } catch (error) {
        state.pos = start
        return failAt(state, `${node.name ?? describe(node.inner)}: ${exceptionMessage(error)}`)
      }
    }
    case "TransformOrFail": {
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
      if (Option.isNone(key)) return failAt(state, "a bound match ref")
      const matchCase = caseFor(node.cases, key.value)
      if (matchCase === undefined) return failAt(state, `a match case for ${preview(key.value)}`)
      return go(matchCase.grammar, state, env)
    }
    case "Dependent": {
      const values = Option.all(node.deps.map((dep) => evaluate(dep, env)))
      if (Option.isNone(values)) return failAt(state, "bound dependency refs")
      try {
        const chosen = node.select(values.value.map(unsafeToNever))
        if (chosen !== undefined) return go(chosen, state, env)
        return failAt(state, node.show(values.value.map(preview), render))
      } catch (error) {
        return failAt(state, `dependent: ${exceptionMessage(error)}`)
      }
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (Option.isNone(count)) return failAt(state, "a bound take count")
      if (!isCount(count.value)) return failAt(state, `<char>{${preview(count.value)}}`)
      if (state.input.length - state.pos < count.value) {
        return failAt(state, `${count.value} chars`)
      }
      const value = state.input.slice(state.pos, state.pos + count.value)
      state.pos += count.value
      return value
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (Option.isNone(count)) return failAt(state, "a bound repeat count")
      if (!isCount(count.value)) return failAt(state, `a non-negative repeat count`)
      const values: Array<Value> = []
      for (let index = 0; index < count.value; index++) {
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
  const found = state.input.slice(state.furthest)[Symbol.iterator]().next()
  return new ParseError({
    pos: state.furthest,
    line: before.split("\n").length,
    column: before.length - before.lastIndexOf("\n"),
    expected: [...state.expected],
    found: found.done ? undefined : found.value,
  })
}

export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> => {
  assertClosed(grammar, "parse")
  const state: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const value = go(grammar, state, undefined)
  if (value !== Fail && state.pos === input.length) {
    // SAFETY: interpreting Grammar<A> preserves its output type across every node.
    return Result.succeed(value as A)
  }
  if (value !== Fail) failAt(state, "end of input")
  return Result.fail(toError(state))
}
