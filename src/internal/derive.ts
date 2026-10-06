import { Equal, Predicate, Schema } from "effect"

import {
  type AnyGrammar,
  type BoundExpr,
  type Domain,
  type Expr,
  isCount,
  matchesWhole,
  type Node,
  nodeOf,
  resolve,
  type ScopeId,
  type Suspension,
  type Value,
} from "../core.ts"
import { exceptionMessage, preview } from "../errors.ts"
import { describe } from "./describe.ts"
import type { ReturnLayout } from "./generator.ts"
import { type Emit, emitSchema, type ValueNode } from "./value-schema.ts"

type ValuePath = ReadonlyArray<PropertyKey>
type GraphPath = ReadonlyArray<string | number>

/** A check on the value at `at`, against a bound read from an enclosing gen. */
interface Dependency {
  readonly expr: BoundExpr
  readonly at: ValuePath
  readonly holds: (value: Value, bound: Value, emit: Emit) => string | undefined
}

interface Derived {
  readonly output: ValueNode
  readonly dependencies: ReadonlyArray<Dependency>
}

interface State {
  readonly domain: Domain
  readonly suspensions: Map<Suspension, ValueNode>
}

const independent = (output: ValueNode): Derived => ({ output, dependencies: [] })
const leaf = (schema: Schema.Top): Derived => independent({ _tag: "Schema", schema })

const guarded = (check: () => string | undefined): string | undefined => {
  try {
    return check()
  } catch (error) {
    return exceptionMessage(error)
  }
}

const read = (value: Value, path: ValuePath): Value =>
  path.reduce<Value>((current, key) => {
    // SAFETY: the derived schema has validated the objects and tuples along this returned path.
    const fields = current as Readonly<Record<PropertyKey, Value>>
    return fields[key]
  }, value)

const lengthOf = (value: Value): number | undefined =>
  Predicate.isString(value) || Predicate.isUint8Array(value) || Array.isArray(value) ? value.length : undefined

export const constantSchema = (value: Value): Schema.Top => {
  if (value === undefined) return Schema.Undefined
  if (value === null) return Schema.Null
  if (
    Predicate.isString(value) || Predicate.isBoolean(value) || Predicate.isBigInt(value)
    || (Predicate.isNumber(value) && Number.isFinite(value))
  ) {
    return Schema.Literal(value)
  }
  return Schema.Unknown.check(Schema.makeFilter((input) => Equal.equals(input, value), { expected: preview(value) }))
}

const layoutValue = (layout: ReturnLayout, steps: ReadonlyArray<Derived | undefined>): ValueNode => {
  switch (layout._tag) {
    case "Slot":
      return steps[layout.slot]!.output
    case "Const":
      return { _tag: "Schema", schema: constantSchema(layout.value) }
    case "Object":
      return { _tag: "Struct", fields: layout.fields.map(([key, field]) => [key, layoutValue(field, steps)]) }
    case "Array":
      return { _tag: "Tuple", items: layout.items.map((item) => layoutValue(item, steps)) }
  }
}

interface Source {
  readonly scope: ScopeId
  readonly slot: number
  readonly keys: ValuePath
}

const refOf = (expr: BoundExpr): Source => {
  if (expr._tag === "Ref") return { scope: expr.scope, slot: expr.slot, keys: [] }
  const object = refOf(expr.object)
  return { ...object, keys: [...object.keys, expr.key] }
}

const deriveSequence = (node: Extract<Node, { readonly _tag: "Sequence" }>, path: GraphPath, state: State): Derived => {
  const steps = node.steps.map((step, slot) =>
    step.path === undefined ? undefined : derive(step.grammar, [...path, "steps", slot], state)
  )
  const local: Array<{ readonly at: ValuePath; readonly source: ValuePath; readonly holds: Dependency["holds"] }> = []
  const outer: Array<Dependency> = []
  for (const [slot, step] of node.steps.entries()) {
    const returned = step.path
    const derived = steps[slot]
    if (returned === undefined || derived === undefined) continue
    for (const dependency of derived.dependencies) {
      const at = [...returned, ...dependency.at]
      const ref = refOf(dependency.expr)
      const source = ref.scope === node.scope ? node.steps[ref.slot]?.path : undefined
      if (ref.scope !== node.scope) outer.push({ ...dependency, at })
      else if (source !== undefined) local.push({ at, source: [...source, ...ref.keys], holds: dependency.holds })
    }
  }
  const output = layoutValue(node.output, steps)
  if (local.length === 0) return { output, dependencies: outer }
  return {
    output: {
      _tag: "Check",
      inner: output,
      check: (emit) =>
        Schema.makeFilter((value: Value) =>
          local.flatMap(({ at, source, holds }) => {
            const issue = guarded(() => holds(read(value, at), read(value, source), emit))
            return issue === undefined ? [] : [{ path: at, issue }]
          })
        ),
    },
    dependencies: outer,
  }
}

const units = (domain: Domain, count: Value): string =>
  `${preview(count)} ${domain === "bytes" ? "byte" : "character"}${count === 1 ? "" : "s"}`

const lengthDependency = (
  expr: Expr | undefined,
  expected: (bound: Value) => string,
  holds: (length: number, bound: number) => boolean,
): ReadonlyArray<Dependency> =>
  expr === undefined || expr._tag === "Const" ? [] : [{
    expr,
    at: [],
    holds: (value, bound) => {
      const length = lengthOf(value)
      return length !== undefined && isCount(bound) && holds(length, bound) ? undefined : `Expected ${expected(bound)}`
    },
  }]

const deriveRepeat = (node: Extract<Node, { readonly _tag: "Repeat" }>, item: ValueNode): Derived => {
  const { min, max } = node
  const array: ValueNode = { _tag: "Array", item }
  const check = min._tag === "Const" && max?._tag === "Const"
    ? Schema.isLengthBetween(min.value, max.value)
    : min._tag === "Const" && min.value > 0
    ? Schema.isMinLength(min.value)
    : max?._tag === "Const"
    ? Schema.isMaxLength(max.value)
    : undefined
  const output: ValueNode = check === undefined ? array : { _tag: "Check", inner: array, check: () => check }
  const dependencies = min === max
    ? lengthDependency(min, (bound) => `${preview(bound)} items`, (length, bound) => length === bound)
    : [
      ...lengthDependency(min, (bound) => `at least ${preview(bound)} items`, (length, bound) => length >= bound),
      ...lengthDependency(max, (bound) => `at most ${preview(bound)} items`, (length, bound) => length <= bound),
    ]
  return { output, dependencies }
}

const union = (members: ReadonlyArray<ValueNode>): ValueNode => ({ _tag: "Union", members })

const where = (path: GraphPath): string =>
  path.length === 0 ? "the root" : path.map((part) => (Predicate.isNumber(part) ? `[${part}]` : `.${part}`)).join("")

const derive = (grammar: AnyGrammar, path: GraphPath, state: State): Derived => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Skip":
      return leaf(Schema.Void)
    case "Regex":
      return leaf(
        Schema.String.check(
          Schema.makeFilter((value: string) => matchesWhole(node, value), { expected: `/${node.source}/` }),
        ),
      )
    case "Take": {
      const base = state.domain === "bytes" ? Schema.Uint8Array : Schema.String
      if (node.count._tag !== "Const") {
        return {
          output: { _tag: "Schema", schema: base },
          dependencies: lengthDependency(
            node.count,
            (bound) => units(state.domain, bound),
            (length, bound) => length === bound,
          ),
        }
      }
      const count = node.count.value
      return leaf(
        base.check(
          Schema.makeFilter((value: { readonly length: number }) => value.length === count, {
            expected: units(state.domain, count),
          }),
        ),
      )
    }
    case "Sequence":
      return deriveSequence(node, path, state)
    case "Choice":
      return independent(
        union(node.options.map((option, index) => derive(option, [...path, "options", index], state).output)),
      )
    case "Optional":
      return independent(union([
        derive(node.inner, [...path, "inner"], state).output,
        { _tag: "Schema", schema: Schema.Undefined },
      ]))
    case "Dispatch":
      return independent(
        union(
          node.cases.map(({ key, grammar: branch }, index) => ({
            _tag: "Check",
            inner: derive(branch, [...path, "cases", index, "grammar"], state).output,
            check: () =>
              Schema.makeFilter((value: Value) =>
                Predicate.isObject(value) && Object.hasOwn(value, node.tag) && Object.is(value[node.tag], key)
                  ? undefined
                  : { path: [node.tag], issue: `Expected ${preview(key)}` }
              ),
          })),
        ),
      )
    case "Match": {
      const cases = node.cases.map(({ key, grammar: branch }, index) => ({
        key,
        output: derive(branch, [...path, "cases", index, "grammar"], state).output,
      }))
      const guards = new Map<ValueNode, (value: Value) => boolean>()
      return {
        output: union(cases.map(({ output }) => output)),
        dependencies: [{
          expr: node.scrutinee,
          at: [],
          holds: (value, key, emit) => {
            const matchCase = cases.find((candidate) => Object.is(candidate.key, key))
            if (matchCase === undefined) return `Expected a match case for ${preview(key)}`
            let is = guards.get(matchCase.output)
            if (is === undefined) {
              is = Schema.is(emit(matchCase.output))
              guards.set(matchCase.output, is)
            }
            return is(value) ? undefined : `Expected a value for match case ${preview(key)}`
          },
        }],
      }
    }
    case "Repeat":
      return deriveRepeat(node, derive(node.inner, [...path, "inner"], state).output)
    case "Surrounded":
      return derive(node.inner, [...path, "inner"], state)
    case "Label": {
      const inner = derive(node.inner, [...path, "inner"], state)
      return { ...inner, output: { _tag: "Label", inner: inner.output, name: node.name } }
    }
    case "Filter": {
      const inner = derive(node.inner, [...path, "inner"], state)
      const check = Schema.makeFilter((value: Value) => {
        try {
          return node.predicate(value)
        } catch (error) {
          return `${node.name}: ${exceptionMessage(error)}`
        }
      }, { expected: node.name })
      return { ...inner, output: { _tag: "Check", inner: inner.output, check: () => check } }
    }
    case "Transform": {
      if (node.schema === undefined) {
        throw new Error(
          `codec: the transform of ${describe(node.inner)} at ${where(path)} declares no output schema; `
            + "pass `to` to transform or transformOrFail, or pass a target schema to codec",
        )
      }
      return independent(node.schema((child) => derive(child, [...path, "inner"], state).output))
    }
    case "Suspend": {
      const known = state.suspensions.get(node)
      if (known !== undefined) return independent(known)
      let target: ValueNode
      const lazy: ValueNode = { _tag: "Suspend", body: () => target }
      state.suspensions.set(node, lazy)
      let resolved: AnyGrammar
      try {
        resolved = resolve(node)
      } catch (error) {
        throw new Error(`codec: ${exceptionMessage(error)}`)
      }
      target = derive(resolved, [...path, "resolved"], state).output
      return independent(lazy)
    }
  }
}

/**
 * Derives the schema of the values a grammar parses. Never runs decode, encode, or predicate
 * callbacks. Object keys are preserved, so printing reports unexpected fields as it does directly.
 */
export const valueSchema = (grammar: AnyGrammar, domain: Domain): Schema.Top =>
  // Composite checks move to encodingChecks when flipped; annotate that side to preserve object keys.
  emitSchema(derive(grammar, [], { domain, suspensions: new Map() }).output).pipe(Schema.annotateEncoded({
    parseOptions: { onExcessProperty: "preserve" },
  }))
