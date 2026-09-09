import { Equal, Predicate, Result } from "effect"

import { freeDerive } from "./compile.ts"
import {
  type Grammar,
  type GrammarInternal,
  nodeOf,
  resolve,
  unsafeToNever,
  type Value,
} from "./core.ts"
import {
  bind,
  caseFor,
  evaluate,
  evaluateCount,
  type Frame,
  frame,
  isCount,
  materialize,
  Unbound,
} from "./env.ts"
import { exceptionMessage, hexByte, type ParseError, preview } from "./errors.ts"
import { type Format, type Input, textFormat } from "./format.ts"
import { readNumber, readVarInt } from "./number.ts"
import { describe } from "./render.ts"

interface State {
  readonly input: Input
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
    case "Empty":
      return undefined
    case "ByteLiteral": {
      if (!(state.input instanceof Uint8Array)) return failAt(state, "binary input")
      for (const byte of node.value) {
        if (state.input[state.pos] !== byte) return failAt(state, hexByte(byte))
        state.pos++
      }
      return undefined
    }
    case "Number": {
      if (!(state.input instanceof Uint8Array)) return failAt(state, "binary input")
      if (state.input.length - state.pos < node.width) {
        return failAt(state, `${node.width} bytes`)
      }
      const value = readNumber(node, state.input, state.pos)
      state.pos += node.width
      return value
    }
    case "VarInt": {
      if (!(state.input instanceof Uint8Array)) return failAt(state, "binary input")
      const read = readVarInt(node.signed, state.input, state.pos)
      if (read === undefined) return failAt(state, describe(grammar))
      state.pos += read.width
      return read.value
    }
    case "Derive":
      return failAt(state, freeDerive)
    case "Bytes": {
      if (!(state.input instanceof Uint8Array)) return failAt(state, "binary input")
      const count = evaluateCount(node.count, env)
      if (count === Unbound) return failAt(state, "a bound bytes count")
      if (!isCount(count)) return failAt(state, "a non-negative byte count")
      if (state.input.length - state.pos < count) return failAt(state, `${count} bytes`)
      // Copy explicitly: Buffer.slice would retain the caller's storage.
      const value = new Uint8Array(state.input.subarray(state.pos, state.pos + count))
      state.pos += count
      return value
    }
    case "Literal": {
      if (!Predicate.isString(state.input)) return failAt(state, "text input")
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
      if (!Predicate.isString(state.input)) return failAt(state, "text input")
      node.re.lastIndex = state.pos
      const match = node.re.exec(state.input)
      if (match === null || match.index !== state.pos) return failAt(state, node.name)
      state.pos += match[0].length
      return match[0]
    }
    case "Gen": {
      const local = frame(node.scope, node.slotCount, env)
      for (const step of node.steps) {
        const inner = nodeOf(step.grammar)
        if (inner._tag === "Derive") {
          const target = local.values[inner.target.slot]
          const source = evaluate(inner.source, local)
          if (source === Unbound) return failAt(state, "a bound derive source")
          if (!Equal.equals(target, source)) return failAt(state, `a derived ${preview(source)}`)
          continue
        }
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
      if (!Predicate.isString(state.input)) return failAt(state, "text input")
      const count = evaluateCount(node.count, env)
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
      const count = evaluateCount(node.count, env)
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

export const reparse = <I extends Input, E extends Error>(
  grammar: GrammarInternal,
  input: I,
  env: Frame | undefined,
  format: Format<I, E>,
): Result.Result<Value, E> => {
  const state: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const value = go(grammar, state, env)
  if (value !== Fail && state.pos === input.length) return Result.succeed(value)
  if (value !== Fail) failAt(state, "end of input")
  return Result.fail(format.error(input, state.furthest, [...state.expected]))
}

export const parseWith = <A, I extends Input, E extends Error>(
  grammar: Grammar<A>,
  input: I,
  format: Format<I, E>,
): Result.Result<A, E> => {
  // SAFETY: interpreting Grammar<A> preserves its output type across every node.
  return reparse(grammar, input, undefined, format) as Result.Result<A, E>
}

export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> =>
  parseWith(grammar, input, textFormat)
