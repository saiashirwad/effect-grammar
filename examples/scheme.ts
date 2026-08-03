/**
 * Scheme S-expressions: grammar owns shape; Schema catalog owns special-form arity.
 * Minimal subset: numbers, strings, booleans, symbols, lists, and quote.
 */
import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

type NumberAtom = { readonly kind: "number"; readonly value: number }
type StringAtom = { readonly kind: "string"; readonly value: string }
type BooleanAtom = { readonly kind: "boolean"; readonly value: boolean }
type SymbolAtom = { readonly kind: "symbol"; readonly value: string }
type Atom = NumberAtom | StringAtom | BooleanAtom | SymbolAtom

type List = { readonly kind: "list"; readonly elements: ReadonlyArray<Expr> }
type Quote = { readonly kind: "quote"; readonly inner: Expr }
type Expr = Atom | List | Quote

const numberAtom = Grammar.guard(
  Grammar.map(Grammar.lexeme(Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?/, "number")), {
    to: (raw): NumberAtom => ({ kind: "number", value: Number(raw) }),
    from: (n) => String(n.value),
  }),
  (v) => v.kind === "number",
)

const stringAtom = Grammar.guard(
  Grammar.map(Grammar.lexeme(Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string")), {
    to: (raw): StringAtom => ({ kind: "string", value: JSON.parse(raw) }),
    from: (s) => JSON.stringify(s.value),
  }),
  (v) => v.kind === "string",
)

const booleanAtom = Grammar.guard(
  Grammar.map(Grammar.lexeme(Grammar.regex(/#(?:true|false|t|f)(?=[\s()"'`;,]|$)/, "boolean")), {
    to: (raw): BooleanAtom => ({
      kind: "boolean",
      value: raw === "#t" || raw === "#true",
    }),
    from: (b) => (b.value ? "#t" : "#f"),
  }),
  (v) => v.kind === "boolean",
)

// After numbers/booleans; excludes whitespace, delimiters, and string quotes.
const symbolAtom = Grammar.guard(
  Grammar.map(Grammar.lexeme(Grammar.regex(/[^\s()"'`;,]+/, "symbol")), {
    to: (value): SymbolAtom => ({ kind: "symbol", value }),
    from: (s) => s.value,
  }),
  (v) => v.kind === "symbol",
)

const atom: Grammar.Grammar<Atom> = Grammar.choice(numberAtom, stringAtom, booleanAtom, symbolAtom)

const expr: Grammar.Grammar<Expr> = Grammar.lazy(() => Grammar.choice(quoteExpr, list, atom), {
  name: "expr",
})

const list: Grammar.Grammar<List> = Grammar.guard(
  Grammar.map(Grammar.between(Grammar.symbol("("), Grammar.symbol(")"), Grammar.many(expr)), {
    to: (elements): List => ({ kind: "list", elements }),
    from: (l) => [...l.elements],
  }),
  (v) => v.kind === "list",
)

const quoteExpr: Grammar.Grammar<Quote> = Grammar.guard(
  Grammar.map(Grammar.struct({ tick: Grammar.literal("'"), inner: expr }), {
    to: ({ inner }): Quote => ({ kind: "quote", inner }),
    from: (q) => ({ tick: "'" as const, inner: q.inner }),
  }),
  (v) => v.kind === "quote",
)

const document = Grammar.map(
  Grammar.struct({
    ws1: Grammar.map(Grammar.regex(/\s*/, "whitespace"), { to: () => "", from: () => "" }),
    e: expr,
    ws2: Grammar.map(Grammar.regex(/\s*/, "whitespace"), { to: () => "", from: () => "" }),
    end: Grammar.end,
  }),
  {
    to: ({ e }) => e,
    from: (e) => ({ ws1: "", e, ws2: "", end: undefined }),
  },
)

// --- special-form catalog (arity only; unknown heads are free) ---

interface Spec {
  readonly min: number
  readonly max?: number
}

const form = (min: number, max?: number): Spec => (max === undefined ? { min } : { min, max })

const catalog: Record<string, Spec> = {
  if: form(2, 3),
  quote: form(1, 1),
  lambda: form(2),
  define: form(2, 2),
  "set!": form(2, 2),
  begin: form(1),
  and: form(0),
  or: form(0),
  not: form(1, 1),
  cons: form(2, 2),
  car: form(1, 1),
  cdr: form(1, 1),
  list: form(0),
  "+": form(0),
  "-": form(1),
  "*": form(0),
  "/": form(1),
  "=": form(2),
  "<": form(2),
  ">": form(2),
  "<=": form(2),
  ">=": form(2),
}

const walkLists = function* (e: Expr): Generator<List> {
  switch (e.kind) {
    case "list":
      yield e
      for (const el of e.elements) yield* walkLists(el)
      break
    case "quote":
      yield* walkLists(e.inner)
      break
    case "number":
    case "string":
    case "boolean":
    case "symbol":
      break
  }
}

const headSymbol = (list: List): string | undefined => {
  const head = list.elements[0]
  return head?.kind === "symbol" ? head.value : undefined
}

const catalogIssues = (e: Expr): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  for (const node of walkLists(e)) {
    const name = headSymbol(node)
    if (name === undefined) continue
    const spec = catalog[name]
    if (spec === undefined) continue
    const arity = node.elements.length - 1
    if (arity < spec.min) {
      issues.push({
        path: [name],
        issue: `expected at least ${spec.min} argument(s), got ${arity}`,
      })
      continue
    }
    if (spec.max !== undefined && arity > spec.max) {
      issues.push({
        path: [name],
        issue: `expected at most ${spec.max} argument(s), got ${arity}`,
      })
    }
  }
  return issues
}

// AST schema: Encoded/Type = Expr so Grammar.toSchema is typed (not Schema.Unknown).
const ExprSchema: Schema.Codec<Expr> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("number"), value: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("symbol"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    elements: Schema.Array(Schema.suspend((): Schema.Codec<Expr> => ExprSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("quote"),
    inner: Schema.suspend((): Schema.Codec<Expr> => ExprSchema),
  }),
])

const formatIssue = SchemaIssue.makeFormatterDefault()

const show = (e: Expr): string => {
  switch (e.kind) {
    case "number":
      return String(e.value)
    case "string":
      return JSON.stringify(e.value)
    case "boolean":
      return e.value ? "#t" : "#f"
    case "symbol":
      return e.value
    case "quote":
      return "'" + show(e.inner)
    case "list":
      return "(" + e.elements.map(show).join(" ") + ")"
  }
}

const report = (source: string, detail: string, ok: boolean) => {
  const label = ok ? "ok  " : "fail"
  const input = source === "" ? "(empty)" : source
  const body = detail
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")
  return `${label}  ${input}\n${body}`
}

const ValidScheme = Grammar.toSchema(document, ExprSchema, { identifier: "Scheme" }).check(
  Schema.makeFilter(catalogIssues),
)

const samples = [
  "(+ 1 2)",
  '(define x "hello")',
  "(lambda (n) (* n n))",
  "(if #t 1 0)",
  '(list 1 \'foo "bar" #f)',
  "'(a b c)",
  "(begin (define y 10) (+ y 1))",
  "(if #t)",
  "(quote)",
  "(not 1 2)",
  "(+)",
  "(/)",
  "((lambda (x) x) 42)",
  "(define)",
  "( unclosed",
  "",
] as const

Effect.all(
  samples.map((source) =>
    Schema.decodeUnknownEffect(ValidScheme)(source).pipe(
      Effect.match({
        onSuccess: (value) => report(source, show(value), true),
        onFailure: (err) => report(source, formatIssue(err.issue), false),
      }),
      Effect.flatMap(Console.log),
    ),
  ),
).pipe(Effect.runFork)
