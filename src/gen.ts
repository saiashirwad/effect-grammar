import { Predicate, type Types } from "effect"

import {
  type Denote,
  type Expr,
  type Grammar,
  isGrammar,
  isSilent,
  make,
  type Node,
  type Pattern,
  type RefBase,
  RefTypeId,
  type Silent,
  silent,
  type Step,
  type Value,
} from "./core.ts"
import { recoverable } from "./print.ts"
import { describeStep } from "./render.ts"

export type GenGrammar<R> = [R] extends [void] ? Silent : Grammar<Denote<R>>

interface Scope {
  open: boolean
}

class RefImpl {
  declare readonly [RefTypeId]: Types.Covariant<any>
}

const refs = new WeakMap<RefBase<any>, { readonly expr: Expr; readonly scope: Scope }>()

const escaped = (): never => {
  throw new TypeError(
    "a Grammar.Ref has no value until parse or print time, so it cannot be compared, " +
      "added, or interpolated here; branch on it with Grammar.match instead",
  )
}

const refHandler: ProxyHandler<RefImpl> = {
  get(_target, key, receiver) {
    if (key === Symbol.toPrimitive || key === "valueOf" || key === "toString") return escaped
    if (key === "then" || key === "toJSON" || !Predicate.isString(key)) return undefined
    const { expr, scope } = entryOf(receiver)
    return refFor({ _tag: "Prop", object: expr, key }, scope)
  },
}

const refFor = (expr: Expr, scope: Scope) => {
  const ref = new Proxy(new RefImpl(), refHandler)
  refs.set(ref, { expr, scope })
  return ref
}

const isRef = (value: Value): value is RefBase<any> => value instanceof RefImpl

const entryOf = (ref: RefBase<any>) => {
  const entry = refs.get(ref)
  if (entry === undefined) throw new TypeError("expected a Grammar.Ref")
  return entry
}

export const assertInScope = (ref: RefBase<any>, where: string) => {
  const { expr, scope } = entryOf(ref)
  if (!scope.open) {
    throw new Error(
      `${where}: this ref is out of scope; a ref can only be used inside the gen that bound it, while that gen is being built`,
    )
  }
  return expr
}

let nextId = 0

const isPlainObject = (value: Value): value is object => {
  if (!Predicate.isObject(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const toPattern = (value: Value): Pattern => {
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
  if (Array.isArray(value)) return { _tag: "Array", items: value.map(toPattern) }
  if (isPlainObject(value)) {
    return { _tag: "Object", fields: Object.entries(value).map(([k, v]) => [k, toPattern(v)]) }
  }
  return { _tag: "Const", value }
}

const validate = (steps: ReadonlyArray<Step>, result: Pattern) => {
  const binds = new Map<number, () => string>()
  steps.forEach((step, index) => {
    if (step._tag === "Bind") binds.set(step.id, () => describeStep(step, index))
  })
  const returned = new Set<number>()
  const collect = (p: Pattern) => {
    switch (p._tag) {
      case "Ref": {
        const where = binds.get(p.id)
        if (where === undefined) {
          throw new Error(
            "gen: the return holds a ref bound by another gen; return it from the gen that bound it",
          )
        }
        if (returned.has(p.id)) {
          throw new Error(
            `gen: ${where()} is returned twice, so printing could not tell which copy to read`,
          )
        }
        returned.add(p.id)
        return
      }
      case "Const":
        return
      case "Object":
        for (const [, field] of p.fields) collect(field)
        return
      case "Array":
        for (const item of p.items) collect(item)
        return
    }
  }
  collect(result)
  const known = new Set(returned)
  for (const step of steps.toReversed()) {
    if (step._tag === "Bind" && known.has(step.id)) {
      for (const id of recoverable(step.grammar)) known.add(id)
    }
  }
  for (const [id, where] of binds) {
    if (!known.has(id)) {
      throw new Error(
        `gen: ${where()} is parsed but not returned, so printing has nothing to print it from; return it, or discard it with skip`,
      )
    }
  }
}

export const gen = <R>(run: () => Generator<Grammar<any>, R, any>): GenGrammar<R> => {
  const it = run()
  const steps: Array<Step> = []
  const scope: Scope = { open: true }
  try {
    let r = it.next()
    while (!r.done) {
      const g = r.value
      if (!isGrammar(g)) throw new TypeError("gen: only a grammar can be yielded")
      if (isSilent(g)) {
        steps.push({ _tag: "Silent", grammar: g })
        r = it.next()
      } else {
        const id = nextId++
        steps.push({ _tag: "Bind", id, grammar: g })
        r = it.next(refFor({ _tag: "Ref", id }, scope))
      }
    }
    const result = toPattern(r.value)
    validate(steps, result)
    const node: Node = { _tag: "Gen", steps, result }
    const bare = result._tag === "Const" && result.value === undefined
    // SAFETY: a void return with no bindings is the Silent arm of GenGrammar; anything else is Grammar<Denote<R>>.
    return (bare ? silent(node) : make(node)) as GenGrammar<R>
  } finally {
    scope.open = false
  }
}

export const seq = (...parts: ReadonlyArray<Silent>) =>
  gen(function* () {
    for (const part of parts) yield* part
  })
