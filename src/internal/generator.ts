import { Equal, Predicate, Result } from "effect"

import {
  type AnyGrammar,
  type Denote,
  type Domain,
  type DomainOf,
  type Expr,
  type Grammar,
  isGrammar,
  make,
  type Node,
  Ref,
  type ScopeId,
  type Value,
} from "../core.ts"
import { exceptionMessage, type PrintIssue } from "../errors.ts"
import { describeStep } from "./describe.ts"
import { atPath, catchResult, inspect } from "./runtime.ts"
import { cachedSyntaxVerdict } from "./syntax.ts"

type ValuePath = ReadonlyArray<string | number>

export interface SequenceStep {
  readonly grammar: AnyGrammar
  readonly path: ValuePath | undefined
}

export type ReturnLayout =
  | { readonly _tag: "Slot"; readonly slot: number }
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, ReturnLayout]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<ReturnLayout> }

interface Scope {
  readonly id: ScopeId
  open: boolean
}

interface RefEntry {
  readonly expr: Expr
  readonly scope: Scope
}

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, "
      + "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

class RefImpl<A> extends Ref<A> {
  [Symbol.toPrimitive]() {
    return escaped()
  }

  override valueOf() {
    return escaped()
  }

  override toString() {
    return escaped()
  }
}

const refs = new WeakMap<object, RefEntry>()

const refHandler: ProxyHandler<object> = {
  get(target, key, receiver) {
    // oxlint-disable-next-line anti-slop/no-reflect-get -- A proxy trap forwards the read unchanged.
    if (Predicate.isSymbol(key) || key in target) return Reflect.get(target, key, receiver)
    if (key === "then" || key === "toJSON") return undefined
    throw new TypeError(
      `a Grammar.Ref has no fields until parse or print time; use Grammar.get(ref, ${JSON.stringify(key)}) `
        + "to depend on a field, or return the whole ref and use transform to reshape its value",
    )
  },
  ownKeys() {
    throw new TypeError(
      "a Grammar.Ref cannot be spread or enumerated; return the whole ref and use transform to reshape its value",
    )
  },
}

const refFor = <A>(expr: Expr, scope: Scope): Ref<A> => {
  const ref = new Proxy<RefImpl<A>>(new RefImpl<A>(), refHandler)
  refs.set(ref, { expr, scope })
  return ref
}

const entryOf = (ref: Ref<Value>): RefEntry => {
  const entry = refs.get(ref)
  if (entry === undefined) throw new TypeError("expected a Grammar.Ref")
  return entry
}

const isRef = (value: Value): value is Ref<Value> => Predicate.isObject(value) && refs.has(value)

const entryInScope = (ref: Ref<Value>, where: string): RefEntry => {
  const entry = entryOf(ref)
  if (!entry.scope.open) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return entry
}

export const assertInScope = (ref: Ref<Value>, where: string): Expr => entryInScope(ref, where).expr

export const get = <A, K extends keyof A>(ref: Ref<A>, key: K): Ref<A[K]> => {
  const { expr, scope } = entryInScope(ref, "get")
  return refFor({ _tag: "Prop", object: expr, key }, scope)
}

const compileSequence = (
  scope: ScopeId,
  grammars: ReadonlyArray<AnyGrammar>,
  output: ReturnLayout,
): Extract<Node, { readonly _tag: "Sequence" }> => {
  const paths: Array<ValuePath | undefined> = Array.from({ length: grammars.length }, () => undefined)
  const collect = (layout: ReturnLayout, path: ValuePath): void => {
    switch (layout._tag) {
      case "Slot":
        if (paths[layout.slot] !== undefined) {
          throw new Error(
            `gen: ${
              describeStep(grammars[layout.slot]!, layout.slot)
            } is returned twice, so printing could not tell which copy to read`,
          )
        }
        paths[layout.slot] = path
        return
      case "Const":
        return
      case "Object":
        for (const [key, field] of layout.fields) collect(field, [...path, key])
        return
      case "Array":
        layout.items.forEach((item, index) => collect(item, [...path, index]))
    }
  }
  collect(output, [])
  return {
    _tag: "Sequence",
    scope,
    steps: grammars.map((grammar, slot) => ({ grammar, path: paths[slot] })),
    output,
  }
}

export const sequence = <A, D extends Domain>(
  scope: ScopeId,
  grammars: ReadonlyArray<AnyGrammar>,
  output: ReturnLayout,
): Grammar<A, D> => make(compileSequence(scope, grammars, output))

const captureOutput = (value: Value, scope: ScopeId, active: WeakSet<object> = new WeakSet()): ReturnLayout => {
  if (isRef(value)) {
    const { expr } = entryOf(value)
    if (expr._tag === "Ref") {
      if (expr.scope !== scope) {
        throw new Error("gen: the return holds a ref bound by another gen; return it from the gen that bound it")
      }
      return { _tag: "Slot", slot: expr.slot }
    }
    throw new Error(
      "gen: the return holds a property ref; return the whole bound ref and use transform to reshape its value",
    )
  }
  if (isGrammar(value)) {
    throw new Error("gen: the return holds a grammar; yield* it to bind its value, then return the ref")
  }
  if (
    value === null
    || value === undefined
    || Predicate.isString(value)
    || Predicate.isNumber(value)
    || Predicate.isBoolean(value)
    || Predicate.isBigInt(value)
  ) {
    return { _tag: "Const", value }
  }
  if (!Predicate.isObjectOrArray(value)) {
    throw new TypeError("gen: the return pattern contains an unsupported constant")
  }
  if (active.has(value)) throw new TypeError("gen: the return pattern is cyclic")
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("gen: the return pattern contains symbol fields")
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value)
      if (names.length !== value.length + 1) {
        throw new TypeError("gen: return arrays must be dense tuples without extra fields")
      }
      const items: Array<ReturnLayout> = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor?.enumerable !== true) {
          throw new TypeError("gen: return arrays must be dense tuples without extra fields")
        }
        items.push(captureOutput(value[index], scope, active))
      }
      return { _tag: "Array", items }
    }

    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("gen: return objects must have Object.prototype or a null prototype")
    }
    const fields: Array<readonly [string, ReturnLayout]> = []
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true) {
        throw new TypeError("gen: return object fields must be enumerable")
      }
      fields.push([key, captureOutput(value[key], scope, active)])
    }
    return { _tag: "Object", fields }
  } finally {
    active.delete(value)
  }
}

export const gen = <Y extends AnyGrammar, R>(run: () => Generator<Y, R, unknown>): Grammar<Denote<R>, DomainOf<Y>> => {
  const iterator = run()
  const grammars: Array<AnyGrammar> = []
  const scope: Scope = { id: { _tag: "ScopeId" }, open: true }
  try {
    let result = iterator.next()
    while (!result.done) {
      const grammar = result.value
      if (!isGrammar(grammar)) throw new TypeError("gen: only a grammar can be yielded")
      const slot = grammars.push(grammar) - 1
      result = iterator.next(refFor({ _tag: "Ref", scope: scope.id, slot }, scope))
    }
    const node = compileSequence(scope.id, grammars, captureOutput(result.value, scope.id))
    for (const [slot, step] of node.steps.entries()) {
      if (step.path === undefined && cachedSyntaxVerdict(step.grammar) === "no") {
        throw new Error(
          `gen: ${describeStep(step.grammar, slot)} is parsed but not returned; return it, or discard it with skip`,
        )
      }
    }
    return make(node)
  } finally {
    scope.open = false
  }
}

export const Unbound = Symbol("effect-grammar/Unbound")

export interface Frame {
  readonly scope: ScopeId
  readonly parent: Frame | undefined
  readonly values: Array<Value>
}

export const frame = (scope: ScopeId, slotCount: number, parent: Frame | undefined): Frame => ({
  scope,
  parent,
  values: Array.from({ length: slotCount }, () => Unbound),
})

export const evaluate = (expr: Expr, env: Frame | undefined): Value => {
  if (expr._tag === "Const") return expr.value
  if (expr._tag === "Ref") {
    for (let current = env; current !== undefined; current = current.parent) {
      if (current.scope === expr.scope) return current.values[expr.slot]
    }
    return Unbound
  }
  const object = evaluate(expr.object, env)
  if (object === Unbound || !Predicate.isObjectOrArray(object)) return Unbound
  // SAFETY: objects and arrays support property-key access; only own fields are evaluated.
  const fields = object as Readonly<Record<PropertyKey, Value>>
  return Object.hasOwn(fields, expr.key) ? fields[expr.key] : Unbound
}

const setOwn = (object: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

export const assembleOutput = (layout: ReturnLayout, env: Frame): Value => {
  switch (layout._tag) {
    case "Slot":
      return env.values[layout.slot]
    case "Const":
      return layout.value
    case "Object": {
      const object: Record<string, Value> = {}
      for (const [key, field] of layout.fields) {
        const value = assembleOutput(field, env)
        if (value === Unbound) return Unbound
        setOwn(object, key, value)
      }
      return object
    }
    case "Array": {
      const items: Array<Value> = []
      for (const item of layout.items) {
        const value = assembleOutput(item, env)
        if (value === Unbound) return Unbound
        items.push(value)
      }
      return items
    }
  }
}

const validateOwnKeys = (
  value: Readonly<Record<string, Value>>,
  fields: ReadonlyArray<string>,
): Result.Result<Array<string | symbol>, PrintIssue> => {
  const keys = inspect(
    value,
    `an inspectable object with exactly the fields ${fields.join(", ")}`,
    () => {
      const keys = Reflect.ownKeys(value)
      for (const key of keys) Object.getOwnPropertyDescriptor(value, key)
      return keys
    },
    (message) => `could not inspect own fields: ${message}`,
  )
  if (Result.isFailure(keys)) return keys
  return keys.success.every((key) => Predicate.isString(key) && fields.includes(key))
    ? keys
    : Result.fail({
      _tag: "InvalidValue",
      expected: `exactly the fields ${fields.join(", ")}`,
      actual: value,
      detail: "unexpected own field",
    })
}

export const bindOutput = (layout: ReturnLayout, value: Value, env: Frame): Result.Result<void, PrintIssue> => {
  return catchResult(
    () => bindLayout(layout, value, env),
    (error): PrintIssue => ({
      _tag: "InvalidValue",
      expected: `an inspectable ${layout._tag.toLowerCase()} pattern value`,
      actual: value,
      detail: exceptionMessage(error),
    }),
  )
}

const bindLayout = (layout: ReturnLayout, value: Value, env: Frame): Result.Result<void, PrintIssue> => {
  switch (layout._tag) {
    case "Slot":
      env.values[layout.slot] = value
      return Result.void
    case "Const":
      return Equal.equals(value, layout.value)
        ? Result.void
        : Result.fail({ _tag: "ConstantMismatch", expected: layout.value, actual: value })
    case "Object": {
      if (!Predicate.isObject(value)) {
        return Result.fail({ _tag: "TypeMismatch", expected: "an object", actual: value })
      }
      const keys = validateOwnKeys(
        value,
        layout.fields.map(([key]) => key),
      )
      if (Result.isFailure(keys)) return Result.fail(keys.failure)
      for (const [key, field] of layout.fields) {
        if (!keys.success.includes(key)) {
          return Result.fail({ _tag: "AtPath", path: key, issue: { _tag: "MissingField", field: key } })
        }
        const read = inspect(value, "a readable field", () => value[key])
        if (Result.isFailure(read)) return atPath(key, Result.fail(read.failure))
        const result = atPath(key, bindOutput(field, read.success, env))
        if (Result.isFailure(result)) return result
      }
      return Result.void
    }
    case "Array": {
      if (!Array.isArray(value)) return Result.fail({ _tag: "TypeMismatch", expected: "an array", actual: value })
      if (value.length !== layout.items.length) {
        return Result.fail({
          _tag: "InvalidValue",
          expected: `${layout.items.length} items`,
          actual: value.length,
          detail: `expected ${layout.items.length} items, got ${value.length}`,
        })
      }
      for (const [index, item] of layout.items.entries()) {
        const read = inspect(value, "a readable array element", () => value[index])
        if (Result.isFailure(read)) return atPath(index, Result.fail(read.failure))
        const result = atPath(index, bindOutput(item, read.success, env))
        if (Result.isFailure(result)) return result
      }
      return Result.void
    }
  }
}
