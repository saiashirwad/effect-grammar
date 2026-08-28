/**
 * Scheme S-expressions: grammar owns shape; Schema catalog owns special-form arity.
 * Minimal subset: numbers, strings, booleans, symbols, lists, and quote.
 *
 * The schemas are the single source of truth for the AST: atom types are
 * derived from them, and `Grammar.decodeTo` reuses them as guards in both
 * directions, so `choice` picks the right branch when printing.
 */
import { Console, Effect, Iterable, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

// --- AST schemas ---

const NumberAtom = Schema.Struct({ kind: Schema.Literal("number"), value: Schema.Finite })
const StringAtom = Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String })
const BooleanAtom = Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean })
const SymbolAtom = Schema.Struct({ kind: Schema.Literal("symbol"), value: Schema.String })

const AtomSchema = Schema.Union([NumberAtom, StringAtom, BooleanAtom, SymbolAtom])

type Atom = typeof AtomSchema.Type

// The recursive variants can't be derived from their own schemas — declared once, by hand.
type List = { readonly kind: "list"; readonly elements: ReadonlyArray<Expr> }
type Quote = { readonly kind: "quote"; readonly inner: Expr }
type Expr = Atom | List | Quote

const ListSchema: Schema.Codec<List> = Schema.Struct({
  kind: Schema.Literal("list"),
  elements: Schema.Array(Schema.suspend((): Schema.Codec<Expr> => ExprSchema)),
})

const QuoteSchema: Schema.Codec<Quote> = Schema.Struct({
  kind: Schema.Literal("quote"),
  inner: Schema.suspend((): Schema.Codec<Expr> => ExprSchema),
})

const ExprSchema: Schema.Codec<Expr> = Schema.Union([
  NumberAtom,
  StringAtom,
  BooleanAtom,
  SymbolAtom,
  ListSchema,
  QuoteSchema,
])

// --- grammar ---

const numberAtom = Grammar.lexeme(Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?/, "number")).pipe(
  Grammar.decodeTo(NumberAtom)({
    decode: (raw) => ({ kind: "number", value: Number(raw) }),
    encode: (n) => String(n.value),
  }),
)

const stringAtom = Grammar.lexeme(Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string")).pipe(
  Grammar.decodeTo(StringAtom)({
    decode: (raw) => ({ kind: "string", value: JSON.parse(raw) }),
    encode: (s) => JSON.stringify(s.value),
  }),
)

const booleanAtom = Grammar.lexeme(
  Grammar.regex(/#(?:true|false|t|f)(?=[\s()"'`;,]|$)/, "boolean"),
).pipe(
  Grammar.decodeTo(BooleanAtom)({
    decode: (raw) => ({ kind: "boolean", value: raw === "#t" || raw === "#true" }),
    encode: (b) => (b.value ? "#t" : "#f"),
  }),
)

// After numbers/booleans; excludes whitespace, delimiters, and string quotes.
const symbolAtom = Grammar.lexeme(Grammar.regex(/[^\s()"'`;,]+/, "symbol")).pipe(
  Grammar.decodeTo(SymbolAtom)({
    decode: (value) => ({ kind: "symbol", value }),
    encode: (s) => s.value,
  }),
)

const atom: Grammar.Grammar<Atom> = Grammar.choice(numberAtom, stringAtom, booleanAtom, symbolAtom)

const expr: Grammar.Grammar<Expr> = Grammar.suspend(
  () => Grammar.choice(quoteExpr, list, atom),
  "expr",
)

const list: Grammar.Grammar<List> = Grammar.wrap(
  Grammar.symbol("("),
  Grammar.many(expr),
  Grammar.symbol(")"),
).pipe(
  Grammar.decodeTo(ListSchema)({
    decode: (elements) => ({ kind: "list", elements }),
    encode: (l) => [...l.elements],
  }),
)

const quoteExpr: Grammar.Grammar<Quote> = Grammar.prefix("'", expr).pipe(
  Grammar.decodeTo(QuoteSchema)({
    decode: (inner) => ({ kind: "quote", inner }),
    encode: (q) => q.inner,
  }),
)

const document = Grammar.wrap(Grammar.whitespace, expr, Grammar.whitespace)

// --- special-form catalog (arity only; unknown heads are free) ---

const form = (min: number, max = Number.POSITIVE_INFINITY) => ({ min, max })

const catalog: Record<string, { readonly min: number; readonly max: number }> = {
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

const arityIssue = (node: List): Result.Result<Schema.FilterIssue, void> => {
  const name = headSymbol(node)
  const spec = name === undefined ? undefined : catalog[name]
  if (name === undefined || spec === undefined) return Result.failVoid
  const arity = node.elements.length - 1
  if (arity < spec.min) {
    return Result.succeed({
      path: [name],
      issue: `expected at least ${spec.min} argument(s), got ${arity}`,
    })
  }
  if (arity > spec.max) {
    return Result.succeed({
      path: [name],
      issue: `expected at most ${spec.max} argument(s), got ${arity}`,
    })
  }
  return Result.failVoid
}

const catalogIssues = Schema.makeFilter((e: Expr) =>
  Array.from(Iterable.filterMap(walkLists(e), arityIssue)),
)

const ValidScheme = Grammar.toSchema(document, ExprSchema, { identifier: "Scheme" }).check(
  catalogIssues,
)

// --- sample run ---

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
]

const check = (source: string) =>
  Schema.decodeUnknownEffect(ValidScheme)(source).pipe(
    Effect.match({
      onSuccess: (value) => report(source, show(value), true),
      onFailure: (err) => report(source, formatIssue(err.issue), false),
    }),
    Effect.flatMap(Console.log),
  )

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(document)}\n`)
  yield* Effect.forEach(samples, check, { discard: true })
  const printed = yield* Schema.encodeEffect(ValidScheme)({
    kind: "list",
    elements: [
      { kind: "symbol", value: "define" },
      { kind: "symbol", value: "x" },
      { kind: "quote", inner: { kind: "list", elements: [{ kind: "number", value: 1 }] } },
    ],
  })
  yield* Console.log(`\nencode (define x '(1))  →  ${printed}`)
}).pipe(Effect.runSync)
