import { Equal, Predicate, Schema, SchemaAST } from "effect"

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

type ValuePath = ReadonlyArray<PropertyKey>
type GraphPath = ReadonlyArray<string | number>

/** A check on the value at `at`, against a bound read from an enclosing gen. */
interface Dependency {
  readonly expr: BoundExpr
  readonly at: ValuePath
  readonly holds: (value: Value, bound: Value) => string | undefined
}

interface Derived {
  readonly schema: Schema.Top
  readonly dependencies: ReadonlyArray<Dependency>
}

interface State {
  readonly domain: Domain
  readonly suspensions: Map<Suspension, Schema.Top>
}

const independent = (schema: Schema.Top): Derived => ({ schema, dependencies: [] })

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
    || (Predicate.isNumber(value) && !Number.isNaN(value))
  ) {
    return Schema.Literal(value)
  }
  return Schema.Unknown.check(Schema.makeFilter((input) => Equal.equals(input, value), { expected: preview(value) }))
}

const layoutSchema = (layout: ReturnLayout, steps: ReadonlyArray<Derived | undefined>): Schema.Top => {
  switch (layout._tag) {
    case "Slot":
      // SAFETY: a returned slot has a step path, so deriveSequence derived it.
      return steps[layout.slot]!.schema
    case "Const":
      return constantSchema(layout.value)
    case "Object":
      return Schema.Struct(Object.fromEntries(layout.fields.map(([key, field]) => [key, layoutSchema(field, steps)])))
    case "Array":
      return Schema.Tuple(layout.items.map((item) => layoutSchema(item, steps)))
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
  const schema = layoutSchema(node.output, steps)
  if (local.length === 0) return { schema, dependencies: outer }
  const related = Schema.makeFilter((value: Value) =>
    local.flatMap(({ at, source, holds }) => {
      const issue = guarded(() => holds(read(value, at), read(value, source)))
      return issue === undefined ? [] : [{ path: at, issue }]
    })
  )
  return { schema: checkable(schema).check(related), dependencies: outer }
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

const deriveRepeat = (node: Extract<Node, { readonly _tag: "Repeat" }>, inner: Schema.Top): Derived => {
  const { min, max } = node
  const array = Schema.Array(inner)
  const schema = min._tag === "Const" && max?._tag === "Const"
    ? array.check(Schema.isLengthBetween(min.value, max.value))
    : min._tag === "Const" && min.value > 0
    ? array.check(Schema.isMinLength(min.value))
    : max?._tag === "Const"
    ? array.check(Schema.isMaxLength(max.value))
    : array
  const dependencies = min === max
    ? lengthDependency(min, (bound) => `${preview(bound)} items`, (length, bound) => length === bound)
    : [
      ...lengthDependency(min, (bound) => `at least ${preview(bound)} items`, (length, bound) => length >= bound),
      ...lengthDependency(max, (bound) => `at most ${preview(bound)} items`, (length, bound) => length <= bound),
    ]
  return { schema, dependencies }
}

/** Effect does not allow checks directly on Suspend. */
const checkable = (schema: Schema.Top): Schema.Top => SchemaAST.isSuspend(schema.ast) ? Schema.Union([schema]) : schema

const union = (members: ReadonlyArray<Schema.Top>): Schema.Top =>
  members.length === 1 ? members[0]! : Schema.Union(members)

const where = (path: GraphPath): string =>
  path.length === 0 ? "the root" : path.map((part) => (Predicate.isNumber(part) ? `[${part}]` : `.${part}`)).join("")

const derive = (grammar: AnyGrammar, path: GraphPath, state: State): Derived => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
    case "Skip":
      return independent(Schema.Void)
    case "Regex":
      return independent(
        Schema.String.check(
          Schema.makeFilter((value: string) => matchesWhole(node, value), { expected: `/${node.source}/` }),
        ),
      )
    case "Take": {
      const base = state.domain === "bytes" ? Schema.Uint8Array : Schema.String
      if (node.count._tag !== "Const") {
        return {
          schema: base,
          dependencies: lengthDependency(
            node.count,
            (bound) => units(state.domain, bound),
            (length, bound) => length === bound,
          ),
        }
      }
      const count = node.count.value
      return independent(
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
        union(node.options.map((option, index) => derive(option, [...path, "options", index], state).schema)),
      )
    case "Optional":
      return independent(Schema.UndefinedOr(derive(node.inner, [...path, "inner"], state).schema))
    case "Dispatch":
      return independent(
        union(
          node.cases.map(({ key, grammar: branch }, index) =>
            checkable(derive(branch, [...path, "cases", index, "grammar"], state).schema).check(
              Schema.makeFilter((value: Value) =>
                Predicate.isObject(value) && Object.hasOwn(value, node.tag) && Object.is(value[node.tag], key)
                  ? undefined
                  : { path: [node.tag], issue: `Expected ${preview(key)}` }
              ),
            )
          ),
        ),
      )
    case "Match": {
      const cases = node.cases.map(({ key, grammar: branch }, index) => {
        const schema = derive(branch, [...path, "cases", index, "grammar"], state).schema
        return { key, schema, is: Schema.is(schema) }
      })
      return {
        schema: union(cases.map(({ schema }) => schema)),
        dependencies: [{
          expr: node.scrutinee,
          at: [],
          holds: (value, key) => {
            const matchCase = cases.find((candidate) => Object.is(candidate.key, key))
            if (matchCase === undefined) return `Expected a match case for ${preview(key)}`
            return matchCase.is(value) ? undefined : `Expected a value for match case ${preview(key)}`
          },
        }],
      }
    }
    case "Repeat":
      return deriveRepeat(node, derive(node.inner, [...path, "inner"], state).schema)
    case "Surrounded":
      return derive(node.inner, [...path, "inner"], state)
    case "Label": {
      const inner = derive(node.inner, [...path, "inner"], state)
      return { ...inner, schema: inner.schema.annotate({ expected: node.name }) }
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
      return { ...inner, schema: checkable(inner.schema).check(check) }
    }
    case "Transform": {
      if (node.schema === undefined) {
        throw new Error(
          `codec: the transform of ${describe(node.inner)} at ${where(path)} declares no output schema; `
            + "pass `to` to transform or transformOrFail, or pass a target schema to codec",
        )
      }
      return independent(node.schema((child) => derive(child, [...path, "inner"], state).schema))
    }
    case "Suspend": {
      const known = state.suspensions.get(node)
      if (known !== undefined) return independent(known)
      let target: Schema.Top | undefined
      // SAFETY: target is assigned below, before this schema can decode or encode a value.
      const lazy = Schema.suspend((): Schema.Top => target!)
      state.suspensions.set(node, lazy)
      let resolved: AnyGrammar
      try {
        resolved = resolve(node)
      } catch (error) {
        throw new Error(`codec: ${exceptionMessage(error)}`)
      }
      target = derive(resolved, [...path, "resolved"], state).schema
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
  checkable(derive(grammar, [], { domain, suspensions: new Map() }).schema).pipe(Schema.annotateEncoded({
    parseOptions: { onExcessProperty: "preserve" },
  }))
