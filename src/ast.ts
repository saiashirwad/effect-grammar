import { Predicate } from "effect"

import {
  type Expr,
  type GrammarInternal,
  nodeOf,
  type Node,
  type Pattern,
  resolve,
  type ScopeId,
  type Step,
  type Value,
} from "./core.ts"
import { preview } from "./errors.ts"
import { nameBindings, namesFor } from "./render.ts"

export interface RefAst {
  readonly _tag: "Ref"
  readonly scope: string
  readonly slot: number
  readonly name?: string | undefined
}

export type ExprAst =
  | RefAst
  | { readonly _tag: "Prop"; readonly object: ExprAst; readonly key: string | number }

export type PatternAst =
  | RefAst
  | { readonly _tag: "Const"; readonly value: Value }
  | { readonly _tag: "Object"; readonly fields: ReadonlyArray<readonly [string, PatternAst]> }
  | { readonly _tag: "Array"; readonly items: ReadonlyArray<PatternAst> }

export interface MatchCaseAst {
  readonly key: string | number | boolean
  readonly grammar: GrammarAst
}

export type StepAst =
  | { readonly _tag: "Silent"; readonly grammar: GrammarAst }
  | {
      readonly _tag: "Bind"
      readonly slot: number
      readonly name?: string | undefined
      readonly grammar: GrammarAst
    }

export type GrammarAst =
  | { readonly _tag: "Literal"; readonly value: string }
  | {
      readonly _tag: "Regex"
      readonly name: string
      readonly source: string
      readonly flags: string
    }
  | {
      readonly _tag: "Gen"
      readonly scope: string
      readonly slotCount: number
      readonly steps: ReadonlyArray<StepAst>
      readonly result: PatternAst
    }
  | {
      readonly _tag: "Wrap"
      readonly open: GrammarAst
      readonly inner: GrammarAst
      readonly close: GrammarAst
    }
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<GrammarAst> }
  | {
      readonly _tag: "Many"
      readonly inner: GrammarAst
      readonly sep: GrammarAst
      readonly min: number
      readonly max: number | "∞"
    }
  | { readonly _tag: "Optional"; readonly inner: GrammarAst }
  | {
      readonly _tag: "Transform"
      readonly inner: GrammarAst
      readonly decode: string
      readonly encode: string
      readonly is?: string | undefined
      readonly name?: string | undefined
    }
  | {
      readonly _tag: "Skip"
      readonly inner: GrammarAst
      readonly printAs: Value
      readonly show: boolean
    }
  | { readonly _tag: "Label"; readonly name: string; readonly inner: GrammarAst }
  | {
      readonly _tag: "Suspend"
      readonly id: number
      readonly name?: string | undefined
      readonly body: GrammarAst
    }
  | { readonly _tag: "SuspendRef"; readonly id: number; readonly name?: string | undefined }
  | {
      readonly _tag: "Match"
      readonly scrutinee: ExprAst
      readonly cases: ReadonlyArray<MatchCaseAst>
    }
  | { readonly _tag: "Take"; readonly count: ExprAst }
  | { readonly _tag: "RepeatExact"; readonly count: ExprAst; readonly inner: GrammarAst }

interface Context {
  readonly scopes: Map<ScopeId, string>
  readonly names: Map<ScopeId, Map<number, string>>
  readonly suspends: Map<Extract<Node, { _tag: "Suspend" }>, number>
}

const scopeName = (context: Context, scope: ScopeId): string => {
  const existing = context.scopes.get(scope)
  if (existing !== undefined) return existing
  const name = `scope${context.scopes.size}`
  context.scopes.set(scope, name)
  return name
}

const refAst = (expr: Extract<Expr, { _tag: "Ref" }>, context: Context): RefAst => {
  const scope = scopeName(context, expr.scope)
  const name = context.names.get(expr.scope)?.get(expr.slot)
  if (name === undefined) return { _tag: "Ref", scope, slot: expr.slot }
  return { _tag: "Ref", scope, slot: expr.slot, name }
}

const keyAst = (key: PropertyKey): string | number =>
  Predicate.isString(key) || Predicate.isNumber(key) ? key : preview(key)

const exprAst = (expr: Expr, context: Context): ExprAst =>
  expr._tag === "Ref"
    ? refAst(expr, context)
    : { _tag: "Prop", object: exprAst(expr.object, context), key: keyAst(expr.key) }

const patternAst = (pattern: Pattern, context: Context): PatternAst => {
  switch (pattern._tag) {
    case "Ref":
      return refAst(pattern, context)
    case "Const":
      return { _tag: "Const", value: pattern.value }
    case "Object":
      return {
        _tag: "Object",
        fields: pattern.fields.map(([key, field]) => [key, patternAst(field, context)] as const),
      }
    case "Array":
      return { _tag: "Array", items: pattern.items.map((item) => patternAst(item, context)) }
  }
}

const fnName = (f: { readonly name: string }): string => (f.name === "" ? "<anonymous>" : f.name)

const stepAst = (step: Step, context: Context, names: Map<number, string>): StepAst =>
  step._tag === "Silent"
    ? { _tag: "Silent", grammar: walk(step.grammar, context) }
    : {
        _tag: "Bind",
        slot: step.slot,
        name: names.get(step.slot),
        grammar: walk(step.grammar, context),
      }

const walk = (grammar: GrammarInternal, context: Context): GrammarAst => {
  const node = nodeOf(grammar)
  switch (node._tag) {
    case "Literal":
      return { _tag: "Literal", value: node.value }
    case "Regex":
      return { _tag: "Regex", name: node.name, source: node.re.source, flags: node.re.flags }
    case "Gen": {
      const names = namesFor(context.names, node.scope)
      nameBindings(node.result, undefined, node.scope, names)
      const scope = scopeName(context, node.scope)
      return {
        _tag: "Gen",
        scope,
        slotCount: node.slotCount,
        steps: node.steps.map((step) => stepAst(step, context, names)),
        result: patternAst(node.result, context),
      }
    }
    case "Wrap":
      return {
        _tag: "Wrap",
        open: walk(node.open, context),
        inner: walk(node.inner, context),
        close: walk(node.close, context),
      }
    case "Choice":
      return { _tag: "Choice", options: node.options.map((option) => walk(option, context)) }
    case "Many":
      return {
        _tag: "Many",
        inner: walk(node.inner, context),
        sep: walk(node.sep, context),
        min: node.min,
        max: node.max === Number.POSITIVE_INFINITY ? "∞" : node.max,
      }
    case "Optional":
      return { _tag: "Optional", inner: walk(node.inner, context) }
    case "Transform": {
      const inner = walk(node.inner, context)
      if (node.is === undefined) {
        return {
          _tag: "Transform",
          inner,
          decode: fnName(node.decode),
          encode: fnName(node.encode),
          name: node.name,
        }
      }
      return {
        _tag: "Transform",
        inner,
        decode: fnName(node.decode),
        encode: fnName(node.encode),
        is: fnName(node.is),
        name: node.name,
      }
    }
    case "Skip":
      return {
        _tag: "Skip",
        inner: walk(node.inner, context),
        printAs: node.printAs,
        show: node.show,
      }
    case "Label":
      return { _tag: "Label", name: node.name, inner: walk(node.inner, context) }
    case "Suspend": {
      const existing = context.suspends.get(node)
      if (existing !== undefined) return { _tag: "SuspendRef", id: existing, name: node.name }
      const id = context.suspends.size
      context.suspends.set(node, id)
      return { _tag: "Suspend", id, name: node.name, body: walk(resolve(node), context) }
    }
    case "Match":
      return {
        _tag: "Match",
        scrutinee: exprAst(node.scrutinee, context),
        cases: node.cases.map((matchCase) => ({
          key: matchCase.key,
          grammar: walk(matchCase.grammar, context),
        })),
      }
    case "Take":
      return { _tag: "Take", count: exprAst(node.count, context) }
    case "RepeatExact":
      return {
        _tag: "RepeatExact",
        count: exprAst(node.count, context),
        inner: walk(node.inner, context),
      }
  }
}

/** Reflects a grammar into a plain, JSON-shaped tree. */
export const toAst = (grammar: GrammarInternal): GrammarAst =>
  walk(grammar, { scopes: new Map(), names: new Map(), suspends: new Map() })

const formatValue = (value: Value): string =>
  Predicate.isString(value) ? JSON.stringify(value) : preview(value)

const refText = (ref: RefAst): string => ref.name ?? `$${ref.slot}`

const exprText = (expr: ExprAst): string => {
  if (expr._tag === "Ref") return refText(expr)
  const object = exprText(expr.object)
  return Predicate.isString(expr.key) && /^[A-Za-z_$][\w$]*$/.test(expr.key)
    ? `${object}.${expr.key}`
    : `${object}[${preview(expr.key)}]`
}

const patternText = (pattern: PatternAst): string => {
  switch (pattern._tag) {
    case "Ref":
      return refText(pattern)
    case "Const":
      return formatValue(pattern.value)
    case "Object":
      return `{ ${pattern.fields.map(([key, field]) => `${key}: ${patternText(field)}`).join(", ")} }`
    case "Array":
      return `[${pattern.items.map(patternText).join(", ")}]`
  }
}

const boundsText = (min: number, max: number | "∞"): string => {
  if (max === "∞") return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
  return min === max ? `{${min}}` : `{${min},${max}}`
}

const headerOf = (ast: GrammarAst): string => {
  switch (ast._tag) {
    case "Literal":
      return `Literal ${formatValue(ast.value)}`
    case "Regex":
      return `Regex ${ast.name} /${ast.source}/${ast.flags}`
    case "Gen":
      return `Gen ${ast.scope} → ${patternText(ast.result)}`
    case "Wrap":
      return "Wrap"
    case "Choice":
      return "Choice"
    case "Many":
      return `Many ${boundsText(ast.min, ast.max)}`
    case "Optional":
      return "Optional"
    case "Transform":
      return ast.name === undefined ? "Transform" : `Transform ${ast.name}`
    case "Skip":
      return ast.show ? "Skip" : "Skip (hidden)"
    case "Label":
      return `Label ${ast.name}`
    case "Suspend":
      return ast.name === undefined ? `Suspend #${ast.id}` : `Suspend #${ast.id} ${ast.name}`
    case "SuspendRef":
      return ast.name === undefined ? `SuspendRef #${ast.id}` : `SuspendRef #${ast.id} ${ast.name}`
    case "Match":
      return `Match ${exprText(ast.scrutinee)}`
    case "Take":
      return `Take ${exprText(ast.count)}`
    case "RepeatExact":
      return `RepeatExact ${exprText(ast.count)}`
  }
}

const childrenOf = (ast: GrammarAst): ReadonlyArray<readonly [string | undefined, GrammarAst]> => {
  switch (ast._tag) {
    case "Gen":
      return ast.steps.map((step) =>
        step._tag === "Bind"
          ? ([step.name ?? `bind #${step.slot}`, step.grammar] as const)
          : ([undefined, step.grammar] as const),
      )
    case "Wrap":
      return [
        [undefined, ast.open] as const,
        [undefined, ast.inner] as const,
        [undefined, ast.close] as const,
      ]
    case "Choice":
      return ast.options.map((option) => [undefined, option] as const)
    case "Many":
      return [[undefined, ast.inner] as const, ["sep", ast.sep] as const]
    case "Optional":
    case "Transform":
    case "Skip":
    case "Label":
    case "RepeatExact":
      return [[undefined, ast.inner] as const]
    case "Suspend":
      return [[undefined, ast.body] as const]
    case "Match":
      return ast.cases.map(
        (matchCase) => [`${formatValue(matchCase.key)} =>`, matchCase.grammar] as const,
      )
    case "Literal":
    case "Regex":
    case "Take":
    case "SuspendRef":
      return []
  }
}

const renderTree = (ast: GrammarAst): string => {
  const lines: Array<string> = [headerOf(ast)]
  const visit = (node: GrammarAst, padding: string): void => {
    const children = childrenOf(node)
    children.forEach(([label, child], index) => {
      const last = index === children.length - 1
      lines.push(
        `${padding}${last ? "└─ " : "├─ "}${label === undefined ? "" : `${label} `}${headerOf(child)}`,
      )
      visit(child, `${padding}${last ? "   " : "│  "}`)
    })
  }
  visit(ast, "")
  return lines.join("\n")
}

export const renderAst = (grammar: GrammarInternal): string => renderTree(toAst(grammar))
