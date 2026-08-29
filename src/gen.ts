import { Predicate, type Types } from "effect"

import {
  type Value,
  type Denote,
  type Expr,
  type Grammar,
  type GrammarInternal,
  isGrammar,
  isSilent,
  make,
  type Node,
  type Pattern,
  type Ref,
  type RefBase,
  RefTypeId,
  type ScopeId,
  type Silent,
  silent,
  type Step,
} from "./core.ts"
import { recoverableRefs } from "./recovery.ts"
import { describeStep } from "./render.ts"

export type GenGrammar<R> = [R] extends [void] ? Silent : Grammar<Denote<R>>

interface Scope {
  readonly id: ScopeId
  open: boolean
}

interface RefEntry {
  readonly expr: Expr
  readonly scope: Scope
}

class RefImpl<A> implements RefBase<A> {
  declare readonly [RefTypeId]: Types.Covariant<A>
}

Object.defineProperty(RefImpl.prototype, RefTypeId, { value: RefTypeId })

const refs = new WeakMap<object, RefEntry>()

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, " +
      "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

const entryOf = (ref: RefBase<unknown>): RefEntry => {
  const entry = refs.get(ref)
  if (entry === undefined) throw new TypeError("expected a Grammar.Ref")
  return entry
}

const refFor = <A>(expr: Expr, scope: Scope): Ref<A> => {
  const target = new RefImpl<A>()
  const ref = new Proxy(target, {
    get(_target, key, receiver) {
      if (key === RefTypeId) return RefTypeId
      if (key === Symbol.toPrimitive) return escaped
      if (key === "then" || key === "toJSON") return undefined
      if (key === "valueOf" || key === "toString") return escaped
      if (!Predicate.isString(key)) return undefined
      const entry = entryOf(receiver)
      return refFor({ _tag: "Prop", object: entry.expr, key }, entry.scope)
    },
  })
  refs.set(ref, { expr, scope })
  // SAFETY: refFor creates a proxy that implements the Ref interface for A.
  return ref as Ref<A>
}

const isRef = (value: Value): value is RefBase<unknown> =>
  Predicate.isObject(value) && refs.has(value)

export const assertInScope = (ref: RefBase<unknown>, where: string): Expr => {
  const entry = entryOf(ref)
  if (!entry.scope.open) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return entry.expr
}

export const get = <A, K extends keyof A>(ref: Ref<A>, key: K): Ref<A[K]> => {
  const entry = entryOf(ref)
  if (!entry.scope.open) {
    throw new Error(
      "get: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built",
    )
  }
  return refFor({ _tag: "Prop", object: entry.expr, key }, entry.scope)
}

const isPlainObject = <T extends object>(value: T): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const toPattern = (value: Value, active: WeakSet<object>): Pattern => {
  if (isRef(value)) {
    const { expr } = entryOf(value)
    if (expr._tag !== "Ref") {
      throw new Error(
        "gen: the return holds a property of a ref; printing cannot rebuild a value from one property, so return the whole ref",
      )
    }
    return expr
  }
  if (isGrammar(value)) {
    throw new Error(
      "gen: the return holds a grammar; yield* it to bind its value, then return the ref",
    )
  }
  if (
    value === null ||
    value === undefined ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isBigInt(value)
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
      const items: Array<Pattern> = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor?.enumerable !== true) {
          throw new TypeError("gen: return arrays must be dense tuples without extra fields")
        }
        items.push(toPattern(value[index], active))
      }
      return { _tag: "Array", items }
    }

    if (!isPlainObject(value)) {
      throw new TypeError("gen: return objects must have Object.prototype or a null prototype")
    }
    const fields: Array<readonly [string, Pattern]> = []
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true) {
        throw new TypeError("gen: return object fields must be enumerable")
      }
      fields.push([key, toPattern(value[key], active)])
    }
    return { _tag: "Object", fields }
  } finally {
    active.delete(value)
  }
}

const validate = (scope: ScopeId, steps: ReadonlyArray<Step>, result: Pattern): void => {
  const binds = new Map<number, () => string>()
  steps.forEach((step, index) => {
    if (step._tag === "Bind") binds.set(step.slot, () => describeStep(step, index))
  })

  const returned = new Set<number>()
  const collect = (pattern: Pattern): void => {
    switch (pattern._tag) {
      case "Ref": {
        if (pattern.scope !== scope || !binds.has(pattern.slot)) {
          throw new Error(
            "gen: the return holds a ref bound by another gen; return it from the gen that bound it",
          )
        }
        if (returned.has(pattern.slot)) {
          const where = binds.get(pattern.slot)
          throw new Error(
            `gen: ${where?.() ?? "a binding"} is returned twice, so printing could not tell which copy to read`,
          )
        }
        returned.add(pattern.slot)
        return
      }
      case "Const":
        return
      case "Object":
        for (const [, field] of pattern.fields) collect(field)
        return
      case "Array":
        for (const item of pattern.items) collect(item)
    }
  }
  collect(result)

  const known = new Set(returned)
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    if (step?._tag !== "Bind" || !known.has(step.slot)) continue
    for (const ref of recoverableRefs(step.grammar)) {
      if (ref.scope === scope) known.add(ref.slot)
    }
  }

  for (const [slot, where] of binds) {
    if (!known.has(slot)) {
      throw new Error(
        `gen: ${where()} is parsed but not returned, so printing has nothing to print it from; return it, or discard it with skip`,
      )
    }
  }
}

export const gen = <R>(run: () => Generator<GrammarInternal, R, unknown>): GenGrammar<R> => {
  const iterator = run()
  const steps: Array<Step> = []
  const scope: Scope = { id: { _tag: "ScopeId" }, open: true }
  let slotCount = 0

  try {
    let result = iterator.next()
    while (!result.done) {
      const grammar = result.value
      if (!isGrammar(grammar)) throw new TypeError("gen: only a grammar can be yielded")
      if (isSilent(grammar)) {
        steps.push({ _tag: "Silent", grammar })
        result = iterator.next()
      } else {
        const slot = slotCount++
        steps.push({ _tag: "Bind", slot, grammar })
        result = iterator.next(refFor({ _tag: "Ref", scope: scope.id, slot }, scope))
      }
    }

    const pattern = toPattern(result.value, new WeakSet())
    validate(scope.id, steps, pattern)
    const node: Node = {
      _tag: "Gen",
      scope: scope.id,
      slotCount,
      steps,
      result: pattern,
    }
    const bare = pattern._tag === "Const" && pattern.value === undefined
    // SAFETY: bare is derived from the Const pattern, and make/silent return the matching GenGrammar shape.
    return (bare ? silent(node) : make(node)) as GenGrammar<R>
  } finally {
    scope.open = false
  }
}

export const seq = (...parts: ReadonlyArray<Silent>): Silent =>
  gen(function* () {
    for (const part of parts) yield* part
  })
