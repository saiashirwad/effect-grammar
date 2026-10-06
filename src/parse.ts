import { Result } from "effect"

import {
  type AnyGrammar,
  caseFor,
  type Domain,
  type Grammar,
  isCount,
  type Node,
  nodeOf,
  resolve,
  type Suspension,
  type Value,
} from "./core.ts"
import { exceptionMessage, ParseError, preview } from "./errors.ts"
import { describe } from "./internal/describe.ts"
import { assembleOutput, evaluate, type Frame, frame, Unbound } from "./internal/generator.ts"
import { catchResult } from "./internal/runtime.ts"

interface Diagnostics {
  furthest: number
  expected: Set<string>
  consumingSuccesses: number
}

interface State {
  readonly domain: Domain
  readonly input: string
  pos: number
  readonly diagnostics: Diagnostics
  readonly activeAt: Map<Suspension, Set<number>>
}

const failAt = (state: State, expected: string, position = state.pos): Result.Result<never, void> => {
  const diagnostics = state.diagnostics
  if (position > diagnostics.furthest) {
    diagnostics.furthest = position
    diagnostics.expected = new Set([expected])
  } else if (position === diagnostics.furthest) {
    diagnostics.expected.add(expected)
  }
  return Result.fail(undefined)
}

const parseCount = (state: State, count: Value, what: string): Result.Result<number, void> => {
  if (count === Unbound) return failAt(state, `a bound ${what}`)
  if (!isCount(count)) return failAt(state, `a non-negative ${what}`)
  return Result.succeed(count)
}

const parseGrammar = (grammar: AnyGrammar, state: State, env: Frame | undefined): Result.Result<Value, void> => {
  const start = state.pos
  const result = catchResult(
    () => parseNode(nodeOf(grammar), state, env),
    (error) => {
      failAt(state, `${describe(grammar)}: ${exceptionMessage(error)}`)
    },
  )
  if (Result.isSuccess(result) && state.pos > start) state.diagnostics.consumingSuccesses++
  return result
}

const parseNode = (node: Node, state: State, env: Frame | undefined): Result.Result<Value, void> => {
  switch (node._tag) {
    case "Literal": {
      if (state.input.startsWith(node.value, state.pos)) {
        state.pos += node.value.length
        return Result.void
      }
      const end = state.pos + node.value.length
      let current = state.pos
      while (current < end && state.input[current] === node.value[current - state.pos]) current++
      state.pos = current
      return failAt(state, JSON.stringify(node.value))
    }
    case "Regex": {
      const expression = new RegExp(node.source, `${node.flags}y`)
      expression.lastIndex = state.pos
      const match = expression.exec(state.input)
      if (match === null || match.index !== state.pos) return failAt(state, `/${node.source}/`)
      state.pos += match[0].length
      return Result.succeed(match[0])
    }
    case "Take": {
      const count = evaluate(node.count, env)
      if (count === Unbound) return failAt(state, "a bound take count")
      if (!isCount(count)) return failAt(state, `take{${preview(count)}}`)
      if (state.input.length - state.pos < count) {
        return failAt(
          state,
          `${count} more ${state.domain === "bytes" ? "byte" : "character"}${count === 1 ? "" : "s"}`,
          state.input.length,
        )
      }
      const value = state.input.slice(state.pos, state.pos + count)
      state.pos += count
      return Result.succeed(value)
    }
    case "Sequence": {
      const local = frame(node.scope, node.steps.length, env)
      for (const [slot, step] of node.steps.entries()) {
        const result = parseGrammar(step.grammar, state, local)
        if (Result.isFailure(result)) return result
        local.values[slot] = result.success
      }
      const value = assembleOutput(node.output, local)
      return value === Unbound ? failAt(state, "a bound generator result") : Result.succeed(value)
    }
    case "Surrounded": {
      const open = parseGrammar(node.open, state, env)
      if (Result.isFailure(open)) return open
      const inner = parseGrammar(node.inner, state, env)
      if (Result.isFailure(inner)) return inner
      const close = parseGrammar(node.close, state, env)
      return Result.isFailure(close) ? close : inner
    }
    case "Choice":
    case "Dispatch": {
      const start = state.pos
      const options = node._tag === "Choice" ? node.options : node.cases.map(({ grammar }) => grammar)
      for (const option of options) {
        const result = parseGrammar(option, state, env)
        if (Result.isSuccess(result)) return result
        state.pos = start
      }
      return Result.fail(undefined)
    }
    case "Optional": {
      const start = state.pos
      const result = parseGrammar(node.inner, state, env)
      if (Result.isSuccess(result)) return result
      state.pos = start
      return Result.void
    }
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return failAt(state, "a bound match ref")
      const matchCase = caseFor(node.cases, key)
      if (matchCase === undefined) return failAt(state, `a match case for ${preview(key)}`)
      return parseGrammar(matchCase.grammar, state, env)
    }
    case "Repeat": {
      const min = parseCount(state, evaluate(node.min, env), "repeat count")
      if (Result.isFailure(min)) return min
      const max = node.max === undefined
        ? Result.succeed(Infinity)
        : parseCount(state, evaluate(node.max, env), "repeat count")
      if (Result.isFailure(max)) return max
      const values: Array<Value> = []
      let mark = state.pos
      while (values.length < max.success) {
        const result = parseGrammar(node.inner, state, env)
        if (Result.isFailure(result)) break
        if (state.pos === mark) return failAt(state, "a repetition element that consumes input")
        values.push(result.success)
        mark = state.pos
        if (Result.isFailure(parseGrammar(node.sep, state, env))) break
      }
      state.pos = mark
      return values.length < min.success ? Result.fail(undefined) : Result.succeed(values)
    }
    case "Transform": {
      const start = state.pos
      const result = parseGrammar(node.inner, state, env)
      if (Result.isFailure(result)) return result
      const consumed = state.pos
      try {
        const decoded = node.decode(result.success)
        if (Result.isFailure(decoded)) {
          state.pos = start
          return failAt(state, decoded.failure, consumed)
        }
        return Result.succeed(decoded.success)
      } catch (error) {
        state.pos = start
        return failAt(state, `${describe(node.inner)}: ${exceptionMessage(error)}`, consumed)
      }
    }
    case "Skip": {
      const result = parseGrammar(node.inner, state, env)
      return Result.isFailure(result) ? result : Result.void
    }
    case "Label": {
      const start = state.pos
      const diagnostics = state.diagnostics
      const { furthest, consumingSuccesses } = diagnostics
      const siblings = furthest === start ? [...diagnostics.expected] : []
      const result = parseGrammar(node.inner, state, env)
      if (Result.isFailure(result) && diagnostics.consumingSuccesses === consumingSuccesses) {
        if (diagnostics.furthest === start) diagnostics.expected = new Set([...siblings, node.name])
        else if (diagnostics.furthest > furthest) diagnostics.expected = new Set([node.name])
      }
      return result
    }
    case "Suspend": {
      const positions = state.activeAt.get(node) ?? new Set<number>()
      if (positions.has(state.pos)) return failAt(state, "a non-left-recursive grammar")
      let target: AnyGrammar
      try {
        target = resolve(node)
      } catch (error) {
        return failAt(state, exceptionMessage(error))
      }
      const position = state.pos
      state.activeAt.set(node, positions)
      positions.add(position)
      try {
        return parseGrammar(target, state, env)
      } finally {
        positions.delete(position)
        if (positions.size === 0) state.activeAt.delete(node)
      }
    }
  }
}

export const parseWithEnv = (
  grammar: AnyGrammar,
  text: string,
  env: Frame | undefined,
  domain: Domain = "text",
): Result.Result<Value, ParseError> => {
  const state: State = {
    domain,
    input: text,
    pos: 0,
    diagnostics: { furthest: 0, expected: new Set(), consumingSuccesses: 0 },
    activeAt: new Map(),
  }
  const result = parseGrammar(grammar, state, env)
  if (Result.isSuccess(result)) {
    if (state.pos === text.length) return Result.succeed(result.success)
    failAt(state, "end of input")
  }
  const { furthest, expected } = state.diagnostics
  const before = state.input.slice(0, furthest)
  const code = state.input.codePointAt(furthest)
  return Result.fail(
    new ParseError({
      pos: furthest,
      line: domain === "bytes" ? undefined : before.split("\n").length,
      column: domain === "bytes" ? undefined : before.length - before.lastIndexOf("\n"),
      expected: [...expected],
      found: code === undefined ? undefined : String.fromCodePoint(code),
    }),
  )
}

export const parseDomain = <A, D extends Domain>(
  grammar: Grammar<A, D>,
  input: string,
  domain: Domain = "text",
): Result.Result<A, ParseError> =>
  // SAFETY: interpreting Grammar<A> preserves its output type across every node.
  parseWithEnv(grammar, input, undefined, domain) as Result.Result<A, ParseError>

export const parse: <A>(grammar: Grammar<A, "text">, input: string) => Result.Result<A, ParseError> = parseDomain
