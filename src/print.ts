import { Equal, Predicate, Result } from "effect"

import { freeDerive } from "./compile.ts"
import {
  derivations,
  type Grammar,
  type GrammarInternal,
  type Node,
  nodeOf,
  type Pattern,
  resolve,
  type ScopeId,
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
  Unbound,
} from "./env.ts"
import {
  describeRoundTrip,
  exceptionMessage,
  preview,
  PrintError,
  type PrintIssue,
} from "./errors.ts"
import { type Format, type Input, textFormat } from "./format.ts"
import { numberIssue, varIntIssue, writeNumber, writeVarInt } from "./number.ts"
import { reparse } from "./parse.ts"
import { unifyPattern } from "./pattern.ts"
import { describe, describeStep } from "./render.ts"

class Failure {
  readonly issue: PrintIssue

  constructor(issue: PrintIssue) {
    this.issue = issue
  }
}

const fail = (issue: PrintIssue): Failure => new Failure(issue)

interface Sink<I extends Input> {
  readonly format: Format<I, Error>
  readonly chunks: Array<I>
}

const emit = <I extends Input>(sink: Sink<I>, chunk: Input): Failure | undefined => {
  if (Predicate.isString(chunk) !== (sink.format.kind === "text")) {
    return fail({ _tag: "InvalidValue", expected: `a ${sink.format.kind} grammar`, actual: chunk })
  }
  // SAFETY: a chunk of the sink's kind has the sink's chunk type.
  sink.chunks.push(chunk as I)
  return undefined
}

type RoundTripIssue = Extract<PrintIssue, { _tag: "RoundTrip" }>

/** Parse `printed` back through `grammar`; the issue if it does not read as `value`. */
const roundTripIssue = <I extends Input>(
  grammar: GrammarInternal,
  value: Value,
  printed: I,
  env: Frame | undefined,
  format: Format<I, Error>,
): RoundTripIssue | undefined => {
  const back = reparse(grammar, printed, env, format)
  if (Result.isFailure(back)) {
    return { _tag: "RoundTrip", value, printed, error: back.failure.message }
  }
  return Equal.equals(back.success, value)
    ? undefined
    : { _tag: "RoundTrip", value, printed, parsed: back.success }
}

const bindingPath = (
  pattern: Pattern,
  scope: ScopeId,
  slot: number,
  path: ReadonlyArray<string | number>,
): ReadonlyArray<string | number> | undefined => {
  switch (pattern._tag) {
    case "Ref":
      return pattern.scope === scope && pattern.slot === slot ? path : undefined
    case "Const":
      return undefined
    case "Object":
      for (const [key, field] of pattern.fields) {
        const found = bindingPath(field, scope, slot, [...path, key])
        if (found !== undefined) return found
      }
      return undefined
    case "Array":
      for (const [index, item] of pattern.items.entries()) {
        const found = bindingPath(item, scope, slot, [...path, index])
        if (found !== undefined) return found
      }
      return undefined
  }
}

const issueAt = (issue: PrintIssue, path: ReadonlyArray<string | number>): PrintIssue => {
  let nested = issue
  for (let index = path.length - 1; index >= 0; index--) {
    nested = { _tag: "AtPath", path: path[index]!, issue: nested }
  }
  return nested
}

const outputGen = <I extends Input>(
  node: Extract<Node, { _tag: "Gen" }>,
  value: Value,
  env: Frame | undefined,
  sink: Sink<I>,
): Failure | undefined => {
  const local = frame(node.scope, node.slotCount, env)
  const issue = unifyPattern(node.result, value, local)
  if (issue !== undefined) return fail(issue)
  for (const { slot, expr } of derivations(node.steps)) {
    const derived = evaluate(expr, local)
    if (derived === Unbound) return fail({ _tag: "MissingBinding", binding: "a derive source" })
    const given = local.values[slot]
    if (given === Unbound) {
      bind(local, slot, derived)
    } else if (!Equal.equals(given, derived)) {
      const issue: PrintIssue = { _tag: "InvalidValue", expected: preview(derived), actual: given }
      return fail(issueAt(issue, bindingPath(node.result, node.scope, slot, []) ?? []))
    }
  }

  for (const [index, step] of node.steps.entries()) {
    if (nodeOf(step.grammar)._tag === "Derive") continue
    const failure =
      step._tag === "Silent"
        ? out(step.grammar, undefined, local, sink)
        : local.values[step.slot] === Unbound
          ? fail({ _tag: "MissingBinding", binding: describeStep(step, index) })
          : out(step.grammar, local.values[step.slot], local, sink)
    if (failure !== undefined) {
      const path =
        step._tag === "Bind" ? bindingPath(node.result, node.scope, step.slot, []) : undefined
      return path === undefined ? failure : fail(issueAt(failure.issue, path))
    }
  }
  return undefined
}

const out = <I extends Input>(
  grammar: GrammarInternal,
  value: Value,
  env: Frame | undefined,
  sink: Sink<I>,
): Failure | undefined => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Empty":
      return undefined
    case "ByteLiteral":
      return emit(sink, node.value)
    case "Number": {
      const expected = numberIssue(node, value)
      if (expected !== undefined) return fail({ _tag: "InvalidValue", expected, actual: value })
      // SAFETY: numberIssue accepted the value, so it is a number or bigint.
      return emit(sink, writeNumber(node, value as number | bigint))
    }
    case "VarInt": {
      const expected = varIntIssue(node.signed, value)
      if (expected !== undefined) return fail({ _tag: "InvalidValue", expected, actual: value })
      // SAFETY: varIntIssue accepted the value, so it is a safe integer.
      return emit(sink, writeVarInt(node.signed, value as number))
    }
    case "Derive":
      return fail({ _tag: "InvalidValue", expected: freeDerive, actual: value })
    case "Bytes": {
      const count = evaluateCount(node.count, env)
      if (count === Unbound) return fail({ _tag: "MissingBinding", binding: "bytes count" })
      if (!isCount(count)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative byte count", actual: count })
      }
      if (!(value instanceof Uint8Array)) {
        return fail({ _tag: "TypeMismatch", expected: "a Uint8Array", actual: value })
      }
      return value.length === count
        ? emit(sink, value)
        : fail({ _tag: "InvalidValue", expected: `${count} bytes`, actual: value })
    }
    case "Literal":
      return emit(sink, node.value)
    case "Regex": {
      if (!Predicate.isString(value))
        return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      node.re.lastIndex = 0
      const match = node.re.exec(value)
      if (match === null || match.index !== 0 || match[0].length !== value.length) {
        return fail({
          _tag: "InvalidValue",
          expected: node.name,
          actual: value,
          detail: `${JSON.stringify(value)} does not match /${node.re.source}/`,
        })
      }
      return emit(sink, value)
    }
    case "Gen":
      return outputGen(node, value, env, sink)
    case "Wrap":
      return (
        out(node.open, undefined, env, sink) ??
        out(node.inner, value, env, sink) ??
        out(node.close, undefined, env, sink)
      )
    case "Choice": {
      if (node.on !== undefined) {
        const { tag, keys } = node.on
        if (!Predicate.isObject(value) || !Object.hasOwn(value, tag)) {
          return fail({
            _tag: "TypeMismatch",
            expected: `an object with a ${tag} field`,
            actual: value,
          })
        }
        const key = value[tag]
        const index = keys.findIndex((candidate) => Object.is(candidate, key))
        if (index === -1) {
          return fail({
            _tag: "InvalidValue",
            expected: `${tag} to be one of ${keys.map(preview).join(", ")}`,
            actual: key,
          })
        }
        return out(node.options[index]!, value, env, sink)
      }
      const issues: Array<PrintIssue> = []
      const mark = sink.chunks.length
      for (const option of node.options) {
        const failure = out(option, value, env, sink)
        if (failure === undefined) {
          if (node.checked !== true) return undefined
          const issue = roundTripIssue(
            grammar,
            value,
            sink.format.join(sink.chunks.slice(mark)),
            env,
            sink.format,
          )
          if (issue === undefined) return undefined
          issues.push({
            _tag: "InvalidValue",
            expected: describe(option),
            actual: value,
            detail: describeRoundTrip(issue),
          })
        } else {
          issues.push(failure.issue)
        }
        sink.chunks.length = mark
      }
      return fail({ _tag: "NoAlternative", actual: value, issues })
    }
    case "Many": {
      if (!Array.isArray(value))
        return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length < node.min || value.length > node.max) {
        const expected =
          node.max === Number.POSITIVE_INFINITY
            ? `at least ${node.min}`
            : `${node.min}..${node.max}`
        return fail({
          _tag: "InvalidValue",
          expected: `${expected} items`,
          actual: value,
          detail: `expected ${expected} items, got ${value.length}`,
        })
      }
      return outputItems(node.inner, node.sep, value, env, sink)
    }
    case "Optional":
      return value === undefined ? undefined : out(node.inner, value, env, sink)
    case "Transform": {
      try {
        if (node.is?.(unsafeToNever(value)) === false) {
          return fail({
            _tag: "InvalidValue",
            expected: node.name ?? describe(node.inner),
            actual: value,
          })
        }
        const encoded = node.encode(unsafeToNever(value))
        return Result.isFailure(encoded)
          ? fail({
              _tag: "InvalidValue",
              expected: node.name ?? describe(node.inner),
              actual: value,
              detail: encoded.failure.message,
            })
          : out(node.inner, encoded.success, env, sink)
      } catch (error) {
        return fail({
          _tag: "InvalidValue",
          expected: node.name ?? describe(node.inner),
          actual: value,
          detail: exceptionMessage(error),
        })
      }
    }
    case "Skip":
      return out(node.inner, node.printAs, env, sink)
    case "Label":
      return out(node.inner, value, env, sink)
    case "Suspend":
      return out(resolve(node), value, env, sink)
    case "Match": {
      const key = evaluate(node.scrutinee, env)
      if (key === Unbound) return fail({ _tag: "MissingBinding", binding: "match selector" })
      const matchCase = caseFor(node.cases, key)
      return matchCase === undefined
        ? fail({
            _tag: "InvalidValue",
            expected: `a match case for ${preview(key)}`,
            actual: value,
          })
        : out(matchCase.grammar, value, env, sink)
    }
    case "Take": {
      const count = evaluateCount(node.count, env)
      if (count === Unbound) return fail({ _tag: "MissingBinding", binding: "take count" })
      if (!isCount(count)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
      }
      if (!Predicate.isString(value))
        return fail({ _tag: "TypeMismatch", expected: "a string", actual: value })
      return value.length === count
        ? emit(sink, value)
        : fail({
            _tag: "InvalidValue",
            expected: `${count} UTF-16 code units`,
            actual: value,
          })
    }
    case "RepeatExact": {
      const count = evaluateCount(node.count, env)
      if (count === Unbound) return fail({ _tag: "MissingBinding", binding: "repeat count" })
      if (!isCount(count)) {
        return fail({ _tag: "InvalidValue", expected: "a non-negative count", actual: count })
      }
      if (!Array.isArray(value))
        return fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== count) {
        return fail({
          _tag: "InvalidValue",
          expected: `${count} items`,
          actual: value.length,
        })
      }
      return outputItems(node.inner, undefined, value, env, sink)
    }
  }
}

const outputItems = <I extends Input>(
  inner: GrammarInternal,
  separator: GrammarInternal | undefined,
  items: ReadonlyArray<Value>,
  env: Frame | undefined,
  sink: Sink<I>,
): Failure | undefined => {
  for (const [index, item] of items.entries()) {
    if (index > 0 && separator !== undefined) {
      const failure = out(separator, undefined, env, sink)
      if (failure !== undefined) return failure
    }
    const failure = out(inner, item, env, sink)
    if (failure !== undefined) return fail({ _tag: "AtPath", path: index, issue: failure.issue })
  }
  return undefined
}

export const printWith = <I extends Input>(
  grammar: GrammarInternal,
  value: Value,
  format: Format<I, Error>,
): Result.Result<I, PrintError> => {
  const sink: Sink<I> = { format, chunks: [] }
  const failure = out(grammar, value, undefined, sink)
  return failure === undefined
    ? Result.succeed(format.join(sink.chunks))
    : Result.fail(new PrintError({ issue: failure.issue }))
}

/** Print, then parse the whole output back and confirm it equals the original value. */
export const printCheckedWith = <I extends Input>(
  grammar: GrammarInternal,
  value: Value,
  format: Format<I, Error>,
): Result.Result<I, PrintError> => {
  const printed = printWith(grammar, value, format)
  if (Result.isFailure(printed)) return printed
  const issue = roundTripIssue(grammar, value, printed.success, undefined, format)
  return issue === undefined ? printed : Result.fail(new PrintError({ issue }))
}

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  printWith(grammar, value, textFormat)

export const printChecked = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> =>
  printCheckedWith(grammar, value, textFormat)
