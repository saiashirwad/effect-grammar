import { Predicate } from "effect"

import {
  type Denote,
  enterScope,
  exitScope,
  exprOf,
  freshId,
  type Grammar,
  isGrammar,
  isRef,
  isSilent,
  make,
  refFor,
  type Node,
  type Pattern,
  type Silent,
  silent,
  type Step,
  type Value,
} from "./core.ts"
import { describe } from "./render.ts"

/** A generator with no return, or that returns nothing, is silent. */
export type GenGrammar<R> = [R] extends [void] ? Silent : Grammar<Denote<R>>

const isPlainObject = (value: Value): value is object => {
  if (!Predicate.isObject(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Lift the generator's return into a pattern. Refs, constants, arrays, and plain objects only. */
const toPattern = (value: Value): Pattern => {
  if (isRef(value)) {
    const expr = exprOf(value)
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

/** The bindings that printing can recover from this grammar's own value. */
export const recoverable = (g: Grammar<any>): ReadonlyArray<number> => {
  const n = g.node
  switch (n._tag) {
    case "Label":
    case "Wrap":
    case "Transform":
      return recoverable(n.inner)
    case "Match":
      return n.scrutinee._tag === "Ref" ? [n.scrutinee.id] : []
    case "Dependent":
      return n.recover === undefined ? [] : n.deps.flatMap((d) => (d._tag === "Ref" ? [d.id] : []))
    default:
      return []
  }
}

interface Bind {
  readonly id: number
  readonly index: number
  readonly grammar: Grammar<any>
}

/**
 * Linearity: every binding must appear in the return exactly once, or a later
 * step must recover it from a returned value. Otherwise the printer would have
 * nothing to print it from.
 */
const validate = (steps: ReadonlyArray<Step>, result: Pattern): void => {
  const binds = new Map<number, Bind>()
  steps.forEach((step, index) => {
    if (step._tag === "Bind") binds.set(step.id, { id: step.id, index, grammar: step.grammar })
  })
  const where = (b: Bind) => `step ${b.index + 1} (${describe(b.grammar)})`
  const returned = new Set<number>()
  const collect = (p: Pattern): void => {
    switch (p._tag) {
      case "Ref": {
        const b = binds.get(p.id)
        if (b === undefined) {
          throw new Error(
            "gen: the return holds a ref bound by another gen; return it from the gen that bound it",
          )
        }
        if (returned.has(p.id)) {
          throw new Error(
            `gen: ${where(b)} is returned twice, so printing could not tell which copy to read`,
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
  // Later steps recover earlier ones, so walk backwards and chains resolve in one pass.
  for (const step of steps.toReversed()) {
    if (step._tag === "Bind" && known.has(step.id)) {
      for (const id of recoverable(step.grammar)) known.add(id)
    }
  }
  for (const b of binds.values()) {
    if (!known.has(b.id)) {
      throw new Error(
        `gen: ${where(b)} is parsed but not returned, so printing has nothing to print it from; return it, or discard it with skip`,
      )
    }
  }
}

/**
 * Run the generator once, now, to build a static grammar. Each `yield*` of a
 * value grammar binds a `Ref`; the return is a pattern over those refs. Parsing
 * fills the pattern; printing reads the refs back out of it.
 */
export const gen = <R>(run: () => Generator<Grammar<any>, R, any>): GenGrammar<R> => {
  const it = run()
  const steps: Array<Step> = []
  const scope = enterScope()
  try {
    let r = it.next()
    while (!r.done) {
      const g = r.value
      if (!isGrammar(g)) throw new TypeError("gen: only a grammar can be yielded")
      if (isSilent(g)) {
        steps.push({ _tag: "Silent", grammar: g })
        r = it.next(undefined)
      } else {
        const id = freshId()
        scope.add(id)
        steps.push({ _tag: "Bind", id, grammar: g })
        r = it.next(refFor({ _tag: "Ref", id }))
      }
    }
    const result = toPattern(r.value)
    validate(steps, result)
    const node: Node = { _tag: "Gen", steps, result }
    const bare = result._tag === "Const" && result.value === undefined && binds(steps).length === 0
    // SAFETY: a void return with no bindings is the Silent arm of GenGrammar; anything else is Grammar<Denote<R>>.
    return (bare ? silent(node) : make(node)) as GenGrammar<R>
  } finally {
    exitScope()
  }
}

const binds = (steps: ReadonlyArray<Step>) => steps.filter((s) => s._tag === "Bind")

/** Silent grammars in order. The silent-only form of `gen`. */
export const seq = (...parts: ReadonlyArray<Silent>): Silent =>
  silent({
    _tag: "Gen",
    steps: parts.map((grammar) => ({ _tag: "Silent", grammar })),
    result: { _tag: "Const", value: undefined },
  })
