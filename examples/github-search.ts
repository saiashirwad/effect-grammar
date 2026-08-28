/**
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Iterable, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

const WordValueSchema = Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String })
const QuotedValueSchema = Schema.Struct({ kind: Schema.Literal("quoted"), value: Schema.String })
const CompareValueSchema = Schema.Struct({
  kind: Schema.Literal("compare"),
  op: Schema.Literals([">", ">=", "<", "<="]),
  value: Schema.String,
})
const RangeValueSchema = Schema.Struct({
  kind: Schema.Literal("range"),
  from: Schema.UndefinedOr(Schema.String),
  to: Schema.UndefinedOr(Schema.String),
})

const QualifierValueSchema = Schema.Union([
  WordValueSchema,
  QuotedValueSchema,
  CompareValueSchema,
  RangeValueSchema,
])

const TermWordSchema = Schema.Struct({
  kind: Schema.Literal("term"),
  quoted: Schema.Literal(false),
  value: Schema.String,
})
const TermQuotedSchema = Schema.Struct({
  kind: Schema.Literal("term"),
  quoted: Schema.Literal(true),
  value: Schema.String,
})
const QualifierSchema = Schema.Struct({
  kind: Schema.Literal("qualifier"),
  negate: Schema.Boolean,
  key: Schema.String,
  value: QualifierValueSchema,
})

type QualifierValue = typeof QualifierValueSchema.Type
type Term = typeof TermWordSchema.Type | typeof TermQuotedSchema.Type
type Qualifier = typeof QualifierSchema.Type
type Not = { readonly kind: "not"; readonly inner: Query }
type And = { readonly kind: "and"; readonly parts: ReadonlyArray<Query> }
type Or = { readonly kind: "or"; readonly parts: ReadonlyArray<Query> }
type Group = { readonly kind: "group"; readonly inner: Query }
type Query = Term | Qualifier | Not | And | Or | Group

const QueryRef = Schema.suspend((): Schema.Codec<Query> => QuerySchema)

const NotSchema = Schema.Struct({
  kind: Schema.Literal("not"),
  inner: QueryRef,
})
const AndSchema = Schema.Struct({
  kind: Schema.Literal("and"),
  parts: Schema.Array(QueryRef),
})
const OrSchema = Schema.Struct({
  kind: Schema.Literal("or"),
  parts: Schema.Array(QueryRef),
})
const GroupSchema = Schema.Struct({
  kind: Schema.Literal("group"),
  inner: QueryRef,
})

const QuerySchema = Schema.Union([
  TermWordSchema,
  TermQuotedSchema,
  QualifierSchema,
  NotSchema,
  AndSchema,
  OrSchema,
  GroupSchema,
])

const ws = Grammar.regex(/\s+/, "whitespace").pipe(Grammar.skip(" "))
const token = (expected: string) => Grammar.regex(/[^\s():"']+/, expected)
const doubleQuoted = Grammar.wrap('"', Grammar.regex(/[^"]*/, "string content"), '"')

const compareValue = Grammar.gen(function* () {
  const op = yield* Grammar.field(
    "op",
    Grammar.choice(
      Grammar.literal(">=").pipe(Grammar.as(">=")),
      Grammar.literal("<=").pipe(Grammar.as("<=")),
      Grammar.literal(">").pipe(Grammar.as(">")),
      Grammar.literal("<").pipe(Grammar.as("<")),
    ),
  )
  const value = yield* Grammar.field("value", token("compare value"))
  return { op, value }
}).pipe(
  Grammar.decodeTo(CompareValueSchema)({
    decode: ({ op, value }) => ({ kind: "compare", op, value }),
    encode: (v) => v,
  }),
)

const rangeBound = (name: string) =>
  Grammar.optional(Grammar.regex(/(?:(?!\.\.)[^\s():"'])+/, name))

const rangeValue = Grammar.gen(function* () {
  const from = yield* Grammar.field("from", rangeBound("range start"))
  yield* Grammar.literal("..")
  const to = yield* Grammar.field("to", rangeBound("range end"))
  return { from, to }
}).pipe(
  Grammar.decodeTo(RangeValueSchema)({
    decode: ({ from, to }) => ({ kind: "range", from, to }),
    encode: (v) => v,
  }),
)

const wordValue = token("qualifier value").pipe(
  Grammar.decodeTo(WordValueSchema)({
    decode: (value) => ({ kind: "word", value }),
    encode: (v) => v.value,
  }),
)

const quotedValue = doubleQuoted.pipe(
  Grammar.decodeTo(QuotedValueSchema)({
    decode: (value) => ({ kind: "quoted", value }),
    encode: (v) => v.value,
  }),
)

const qualifierValue = Grammar.choice(quotedValue, compareValue, rangeValue, wordValue)

const qualifier = Grammar.gen(function* () {
  const negate = yield* Grammar.field("negate", Grammar.flag("-"))
  const key = yield* Grammar.field("key", Grammar.regex(/[A-Za-z][A-Za-z0-9-]*/, "qualifier name"))
  yield* Grammar.literal(":")
  const value = yield* Grammar.field("value", qualifierValue)
  return { negate, key, value }
}).pipe(
  Grammar.decodeTo(QualifierSchema)({
    decode: ({ negate, key, value }) => ({ kind: "qualifier", negate, key, value }),
    encode: (q) => q,
  }),
)

const query: Grammar.Grammar<Query> = Grammar.suspend(() => orExpr, "query")

const group = Grammar.wrap(
  "(",
  Grammar.wrap(Grammar.whitespace, query, Grammar.whitespace),
  ")",
).pipe(
  Grammar.decodeTo(GroupSchema)({
    decode: (inner) => ({ kind: "group", inner }),
    encode: (g) => g.inner,
    is: (v) => v.kind === "group",
  }),
)

const termWord = Grammar.regex(/(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/, "search term").pipe(
  Grammar.decodeTo(TermWordSchema)({
    decode: (value) => ({ kind: "term", quoted: false, value }),
    encode: (t) => t.value,
  }),
)

const termQuoted = doubleQuoted.pipe(
  Grammar.decodeTo(TermQuotedSchema)({
    decode: (value) => ({ kind: "term", quoted: true, value }),
    encode: (t) => t.value,
  }),
)

const atom = Grammar.choice(qualifier, group, termQuoted, termWord)

const notExpr: Grammar.Grammar<Query> = Grammar.suspend(
  () => Grammar.choice(notBranch, atom),
  "not",
)

const notBranch = Grammar.prefix(Grammar.seq(Grammar.literal("NOT"), ws), notExpr).pipe(
  Grammar.decodeTo(NotSchema)({
    decode: (inner) => ({ kind: "not", inner }),
    encode: (n) => n.inner,
    is: (v) => v.kind === "not",
  }),
)

const nary = (kind: "and" | "or", sep: Grammar.Silent, part: Grammar.Grammar<Query>) =>
  Grammar.sepBy(part, sep, { min: 1 }).pipe(
    Grammar.transform({
      decode: (parts): Query =>
        parts.length === 1 && parts[0] !== undefined ? parts[0] : { kind, parts },
      encode: (q) => (q.kind === kind ? q.parts : [q]),
    }),
  )

const andSep = Grammar.seq(ws, Grammar.optional(Grammar.seq(Grammar.literal("AND"), ws)))
const andExpr = nary("and", andSep, notExpr)

const orSep = Grammar.seq(ws, Grammar.literal("OR"), ws)
const orExpr = nary("or", orSep, andExpr)

const whole = Grammar.wrap(Grammar.whitespace, query, Grammar.whitespace)

const pattern = (re: RegExp, identifier: string, message: string) =>
  Schema.String.check(Schema.isPattern(re, { identifier, message }))

const GithubBool = Schema.Literals(["true", "false"])
const GithubNumber = pattern(/^\d+$/, "GithubNumber", "expected digits")
const GithubDate = pattern(
  /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/,
  "GithubDate",
  "expected a date (YYYY[-MM[-DD]])",
)
const GithubUser = Schema.Union([
  Schema.Literal("@me"),
  pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "GithubUser", "expected a GitHub username"),
])
const GithubRepo = pattern(
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
  "GithubRepo",
  "expected owner/name",
)

interface Spec {
  readonly decode: (atom: string) => Result.Result<unknown, Schema.SchemaError>
  readonly kinds?: ReadonlyArray<QualifierValue["kind"]> | undefined
}

const spec = (
  atom: Schema.ConstraintDecoder<unknown>,
  kinds?: ReadonlyArray<QualifierValue["kind"]>,
): Spec => ({ decode: Schema.decodeResult(atom), kinds })
const word = (atom: Schema.ConstraintDecoder<unknown>): Spec => spec(atom, ["word"])
const enumOf = <const L extends ReadonlyArray<string>>(values: L): Spec =>
  word(Schema.Literals(values))

const catalog = {
  is: enumOf([
    "open",
    "closed",
    "merged",
    "pr",
    "issue",
    "public",
    "private",
    "archived",
    "unarchived",
    "locked",
    "unlocked",
  ]),
  state: enumOf(["open", "closed"]),
  type: enumOf(["pr", "issue", "repositories", "commits"]),
  status: enumOf(["pending", "success", "failure", "neutral"]),
  review: enumOf(["none", "required", "approved", "changes_requested", "dismissed"]),
  linked: enumOf(["issue", "pr"]),
  visibility: enumOf(["public", "private", "internal"]),
  in: enumOf(["title", "body", "comments", "file", "path"]),
  no: enumOf(["label", "milestone", "assignee", "project"]),
  archived: word(GithubBool),
  draft: word(GithubBool),
  locked: word(GithubBool),
  created: spec(GithubDate),
  updated: spec(GithubDate),
  closed: spec(GithubDate),
  merged: spec(GithubDate),
  pushed: spec(GithubDate),
  stars: spec(GithubNumber),
  forks: spec(GithubNumber),
  size: spec(GithubNumber),
  comments: spec(GithubNumber),
  interactions: spec(GithubNumber),
  reactions: spec(GithubNumber),
  commits: spec(GithubNumber),
  author: spec(GithubUser),
  assignee: spec(GithubUser),
  commenter: spec(GithubUser),
  mentions: spec(GithubUser),
  involves: spec(GithubUser),
  "reviewed-by": spec(GithubUser),
  "review-requested": spec(GithubUser),
  user: spec(GithubUser),
  org: spec(GithubUser),
  repo: spec(GithubRepo),
  label: spec(Schema.String),
  milestone: spec(Schema.String),
  project: spec(Schema.String),
  language: spec(Schema.String),
  license: spec(Schema.String),
  team: spec(Schema.String),
  head: spec(Schema.String),
  base: spec(Schema.String),
  filename: spec(Schema.String),
  path: spec(Schema.String),
  extension: spec(Schema.String),
} satisfies Record<string, Spec>

const isKnownQualifier = (key: string): key is keyof typeof catalog => Object.hasOwn(catalog, key)

const atoms = (v: QualifierValue): ReadonlyArray<string> => {
  switch (v.kind) {
    case "word":
    case "quoted":
    case "compare":
      return [v.value]
    case "range":
      return [v.from, v.to].filter((x): x is string => x !== undefined && x !== "*")
  }
}

const walkQualifiers = function* (q: Query): Generator<Qualifier> {
  switch (q.kind) {
    case "qualifier":
      yield q
      break
    case "not":
    case "group":
      yield* walkQualifiers(q.inner)
      break
    case "and":
    case "or":
      for (const part of q.parts) yield* walkQualifiers(part)
      break
    case "term":
      break
  }
}

const qualifierIssues = (node: Qualifier): ReadonlyArray<Schema.FilterIssue> => {
  const path = [node.key]
  if (!isKnownQualifier(node.key)) return [{ path, issue: "unknown qualifier" }]
  const spec = catalog[node.key]
  if (spec.kinds !== undefined && !spec.kinds.includes(node.value.kind)) {
    return [{ path, issue: `expected ${spec.kinds.join(" | ")}, got ${node.value.kind}` }]
  }
  return atoms(node.value).flatMap((a) => {
    const r = spec.decode(a)
    return Result.isFailure(r) ? [{ path, issue: r.failure.issue }] : []
  })
}

const catalogIssues = (q: Query): ReadonlyArray<Schema.FilterIssue> =>
  Array.from(Iterable.flatMap(walkQualifiers(q), qualifierIssues))

const ValidGithubQuery = Grammar.toSchema(whole, QuerySchema, { identifier: "GithubQuery" }).check(
  Schema.makeFilter(catalogIssues),
)

const decode = Schema.decodeEffect(ValidGithubQuery)
const encode = Schema.encodeEffect(ValidGithubQuery)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const formatIssue = SchemaIssue.makeFormatterDefault()

const grouped = "(author:foo OR author:bar) is:pr -is:archived"

const samples = [
  "is:pr author:foo label:bug",
  grouped,
  "NOT draft:true stars:10..1000 language:TypeScript",
  'label:"help wanted" in:title created:>=2024-01-01 pushed:*..2024-06-30',
  "repo:effect-ts/effect path:src extension:ts",
  "is:maybe",
  "stars:abc",
  "created:2020-13-99",
  "frobnicate:x",
  "repo:notasluginthere",
  "is:pr (unclosed",
  "is:",
]

const check = (source: string) =>
  decode(source).pipe(
    Effect.match({
      onSuccess: (value) => `decode ${json(source)}\n  →  ${json(value)}`,
      onFailure: (err) => `decode ${json(source)}\n  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(whole)}\n`)
  yield* Effect.forEach(samples, check, { discard: true })
  const decoded = yield* decode(grouped)
  yield* Console.log(`\nencode  →  ${yield* encode(decoded)}`)
}).pipe(Effect.runSync)
