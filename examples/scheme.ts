import { Console, Effect, Iterable, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

const NumberAtom = Schema.Struct({ kind: Schema.Literal("number"), value: Schema.Finite })
const StringAtom = Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String })
const BooleanAtom = Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean })
const SymbolAtom = Schema.Struct({ kind: Schema.Literal("symbol"), value: Schema.String })

const AtomSchema = Schema.Union([NumberAtom, StringAtom, BooleanAtom, SymbolAtom])

type Atom = typeof AtomSchema.Type

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

interface FormSpec {
  readonly min: number
  readonly max: number
}

const form = (min: number, max = Number.POSITIVE_INFINITY): FormSpec => ({ min, max })
const catalog = {
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
} satisfies Record<string, { readonly min: number; readonly max: number }>

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

const isCatalogForm = (name: string): name is keyof typeof catalog => Object.hasOwn(catalog, name)

const arityIssue = (node: List): Result.Result<Schema.FilterIssue, void> => {
  const name = headSymbol(node)
  if (name === undefined || !isCatalogForm(name)) return Result.failVoid
  const spec = catalog[name]
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

const formatIssue = SchemaIssue.makeFormatterDefault()

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
  Schema.decodeEffect(ValidScheme)(source).pipe(
    Effect.match({
      onSuccess: (value) =>
        `decode ${source || "(empty)"}\n  →  ${Schema.encodeSync(ValidScheme)(value)}`,
      onFailure: (err) => `decode ${source || "(empty)"}\n  →  ${formatIssue(err.issue)}`,
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
