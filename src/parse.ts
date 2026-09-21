import { Predicate, Result } from "effect"

import { type Grammar, type GrammarInternal, type Node, nodeOf, resolve, unsafeToNever, type Value } from "./core.ts"
import {
  bind,
  caseFor,
  copyFields,
  evaluate,
  type Frame,
  frame,
  isCount,
  materialize,
  nonByte,
  Unbound,
} from "./env.ts"
import { exceptionMessage, ParseError, preview } from "./errors.ts"
import { describe } from "./render.ts"

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
  readonly suspended: Map<Node, Set<number>>
}

const failAt = (state: State, expected: string, position = state.pos): Result.Result<never, void> => {
  if (position > state.furthest) {
    state.furthest = position
    state.expected = new Set([expected])
  } else if (position === state.furthest) {
    state.expected.add(expected)
  }
  return Result.fail(undefined)
}

const parseGrammar = (grammar: GrammarInternal, state: State, env: Frame | undefined): Result.Result<Value, void> => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal": {
      if (state.input.startsWith(node.value, state.pos)) {
        state.pos += node.value.length
        return Result.void
      }
      // Report the first mismatch, not the start of the literal.
      const end = state.pos + node.value.length
      let current = state.pos
      while (current < end && state.input[current] === node.value[current - state.pos]) current++
      state.pos = current
      return failAt(state, node.name ?? JSON.stringify(node.value))
    }
    case "Regex": {
      const expression = new RegExp(node.source, `${node.flags}y`)
      expression.lastIndex = state.pos
      const match = expression.exec(state.input)
      if (match === null || match.index !== state.pos) return failAt(state, node.name)
      state.pos += match[0].length
      return Result.succeed(match[0])
    }
    case "Gen": {
      const local = frame(node.scope, node.slotCount, env)
      for (const step of node.steps) {
        const result = parseGrammar(step.grammar, state, local)
        if (Result.isFailure(result)) return result
        if (step._tag === "Bind") bind(local, step.slot, result.success)
      }
      const value = materialize(node.result, local)
      return value === Unbound ? failAt(state, "a bound generator result") : Result.succeed(value)
    }
    case "Wrap": {
      const open = parseGrammar(node.open, state, env)
      if (Result.isFailure(open)) return open
      const inner = parseGrammar(node.inner, state, env)
      if (Result.isFailure(inner)) return inner
      const close = parseGrammar(node.close, state, env)
      return Result.isFailure(close) ? close : inner
    }
    case "Choice": {
      const start = state.pos
      for (const option of node.options) {
        const result = parseGrammar(option, state, env)
        if (Result.isSuccess(result)) return result
        state.pos = start
      }
      return Result.fail(undefined)
    }
    case "Many": {
      const values: Array<Value> = []
      let mark = state.pos
      while (values.length < node.max) {
        const result = parseGrammar(node.inner, state, env)
        if (Result.isFailure(result)) break
        if (state.pos === mark) return failAt(state, "a repetition element that consumes input")
        values.push(result.success)
        mark = state.pos
        if (Result.isFailure(parseGrammar(node.sep, state, env))) break
      }
      state.pos = mark
      return values.length < node.min ? Result.fail(undefined) : Result.succeed(values)
    }
    case "Optional": {
      const mark = state.pos
      const result = parseGrammar(node.inner, state, env)
      if (Result.isSuccess(result)) return result
      state.pos = mark
      return Result.void
    }
    case "Transform": {
      const start = state.pos
      const result = parseGrammar(node.inner, state, env)
      if (Result.isFailure(result)) return result
      const consumed = state.pos
      try {
        const decoded = node.decode(unsafeToNever(result.success))
        if (Result.isFailure(decoded)) {
          state.pos = start
          return failAt(state, decoded.failure.message, consumed)
        }
        if (node.is?.(unsafeToNever(decoded.success)) === false) {
          state.pos = start
          return failAt(state, node.name ?? describe(node.inner), consumed)
        }
        return Result.succeed(decoded.success)
      } catch (error) {
        state.pos = start
        return failAt(state, `${node.name ?? describe(node.inner)}: ${exceptionMessage(error)}`, consumed)
      }
    }
    case "Skip": {
      const result = parseGrammar(node.inner, state, env)
      return Result.isFailure(result) ? result : Result.void
    }
    case "Label": {
      const start = state.pos
      const siblings = state.furthest === start ? [...state.expected] : []
      const result = parseGrammar(node.inner, state, env)
      if (Result.isFailure(result) && state.furthest === start) {
        state.expected = new Set([...siblings, node.name])
      }
      return result
    }
    case "Suspend": {
      const positions = state.suspended.get(node) ?? new Set<number>()
      if (positions.has(state.pos)) return failAt(state, "a non-left-recursive grammar")
      state.suspended.set(node, positions)
      const position = state.pos
      positions.add(position)
      try {
        let target: GrammarInternal
        try {
          target = resolve(node)
        } catch (error) {
          return failAt(state, exceptionMessage(error))
        }
        return parseGrammar(target, state, env)
      } finally {
        positions.delete(position)
        if (positions.size === 0) state.suspended.delete(node)
      }
    }
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return failAt(state, "a bound match ref")
      const matchCase = caseFor(node.cases, key)
      if (matchCase === undefined) return failAt(state, `a match case for ${preview(key)}`)
      return parseGrammar(matchCase.grammar, state, env)
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return failAt(state, "a bound take count")
      if (!isCount(count)) return failAt(state, `<${node.unit}>{${preview(count)}}`)
      const available = state.input.length - state.pos
      if (available < count) {
        if (node.unit === "char") return failAt(state, `${count} chars`)
        const expected = `${count} bytes but only ${available} remain`
        return failAt(state, node.name === undefined ? expected : `${node.name}: ${expected}`, state.input.length)
      }
      const value = state.input.slice(state.pos, state.pos + count)
      if (node.unit === "byte") {
        const index = value.search(nonByte)
        if (index !== -1) return failAt(state, "a byte", state.pos + index)
      }
      state.pos += count
      return Result.succeed(value)
    }
    case "RepeatExact": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return failAt(state, "a bound repeat count")
      if (!isCount(count)) return failAt(state, `a non-negative repeat count`)
      const values: Array<Value> = []
      for (let index = 0; index < count; index++) {
        const mark = state.pos
        const result = parseGrammar(node.inner, state, env)
        if (Result.isFailure(result)) return result
        if (state.pos === mark) return failAt(state, "a repetition element that consumes input")
        values.push(result.success)
      }
      return Result.succeed(values)
    }
    case "Merge": {
      const merged: Record<string, Value> = {}
      for (const part of node.parts) {
        const start = state.pos
        const result = parseGrammar(part.grammar, state, env)
        if (Result.isFailure(result)) return result
        if (!Predicate.isObject(result.success)) return failAt(state, "an object to merge", start)
        copyFields(merged, result.success, part.keys)
      }
      return Result.succeed(merged)
    }
  }
}

export const reparse = (
  grammar: GrammarInternal,
  text: string,
  env: Frame | undefined,
): Result.Result<Value, ParseError> => {
  const state: State = {
    input: text,
    pos: 0,
    furthest: 0,
    expected: new Set(),
    suspended: new Map(),
  }
  const result = parseGrammar(grammar, state, env)
  if (Result.isSuccess(result)) {
    if (state.pos === text.length) return Result.succeed(result.success)
    failAt(state, "end of input")
  }
  const before = state.input.slice(0, state.furthest)
  const code = state.input.codePointAt(state.furthest)
  return Result.fail(
    new ParseError({
      pos: state.furthest,
      line: before.split("\n").length,
      column: before.length - before.lastIndexOf("\n"),
      expected: [...state.expected],
      found: code === undefined ? undefined : String.fromCodePoint(code),
    }),
  )
}

// Parse the entire input.
export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> =>
  // SAFETY: interpreting Grammar<A> preserves its output type across every node.
  reparse(grammar, input, undefined) as Result.Result<A, ParseError>
