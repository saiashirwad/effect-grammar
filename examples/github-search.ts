/**
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

type CompareOp = ">" | ">=" | "<" | "<="

type QualifierValue =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "quoted"; readonly value: string }
  | { readonly kind: "compare"; readonly op: CompareOp; readonly value: string }
  | { readonly kind: "range"; readonly from: string | undefined; readonly to: string | undefined }

type Term = { readonly kind: "term"; readonly quoted: boolean; readonly value: string }
type Qualifier = {
  readonly kind: "qualifier"
  readonly negate: boolean
  readonly key: string
  readonly value: QualifierValue
}
type Not = { readonly kind: "not"; readonly inner: Query }
type And = { readonly kind: "and"; readonly parts: ReadonlyArray<Query> }
type Or = { readonly kind: "or"; readonly parts: ReadonlyArray<Query> }
type Group = { readonly kind: "group"; readonly inner: Query }
type Query = Term | Qualifier | Not | And | Or | Group

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
const NotSchema: Schema.Codec<Not> = Schema.Struct({
  kind: Schema.Literal("not"),
  inner: Schema.suspend((): Schema.Codec<Query> => QuerySchema),
})
const AndSchema: Schema.Codec<And> = Schema.Struct({
  kind: Schema.Literal("and"),
  parts: Schema.Array(Schema.suspend((): Schema.Codec<Query> => QuerySchema)),
})
const OrSchema: Schema.Codec<Or> = Schema.Struct({
  kind: Schema.Literal("or"),
  parts: Schema.Array(Schema.suspend((): Schema.Codec<Query> => QuerySchema)),
})
const GroupSchema: Schema.Codec<Group> = Schema.Struct({
  kind: Schema.Literal("group"),
  inner: Schema.suspend((): Schema.Codec<Query> => QuerySchema),
})

const QuerySchema: Schema.Codec<Query> = Schema.Union([
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
    encode: (v) => ({ op: v.op, value: v.value }),
  }),
)

const rangeValue = Grammar.regex(/[^\s():"']*\.\.[^\s():"']*/, "range").pipe(
  Grammar.decodeTo(RangeValueSchema)({
    decode: (raw) => {
      const i = raw.indexOf("..")
      const from = raw.slice(0, i)
      const to = raw.slice(i + 2)
      return { kind: "range", from: from === "" ? undefined : from, to: to === "" ? undefined : to }
    },
    encode: (v) => (v.from ?? "") + ".." + (v.to ?? ""),
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
    encode: (q) => ({ negate: q.negate, key: q.key, value: q.value }),
  }),
)

const query: Grammar.Grammar<Query> = Grammar.suspend(() => orExpr, "query")

const group: Grammar.Grammar<Group> = Grammar.gen(function* () {
  yield* Grammar.literal("(")
  yield* Grammar.whitespace
  const inner = yield* Grammar.field("inner", query)
  yield* Grammar.whitespace
  yield* Grammar.literal(")")
  return { inner }
}).pipe(
  Grammar.decodeTo(GroupSchema)({
    decode: ({ inner }) => ({ kind: "group", inner }),
    encode: (g) => ({ inner: g.inner }),
  }),
)

const termWord: Grammar.Grammar<Term> = Grammar.regex(
  /(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/,
  "search term",
).pipe(
  Grammar.decodeTo(TermWordSchema)({
    decode: (value) => ({ kind: "term", quoted: false, value }),
    encode: (t) => t.value,
  }),
)

const termQuoted: Grammar.Grammar<Term> = doubleQuoted.pipe(
  Grammar.decodeTo(TermQuotedSchema)({
    decode: (value) => ({ kind: "term", quoted: true, value }),
    encode: (t) => t.value,
  }),
)

const atom: Grammar.Grammar<Query> = Grammar.choice(qualifier, group, termQuoted, termWord)

const notExpr: Grammar.Grammar<Query> = Grammar.suspend(
  () => Grammar.choice(notBranch, atom),
  "not",
)

const notBranch: Grammar.Grammar<Not> = Grammar.gen(function* () {
  yield* Grammar.literal("NOT")
  yield* ws
  const inner = yield* Grammar.field("inner", notExpr)
  return { inner }
}).pipe(
  Grammar.decodeTo(NotSchema)({
    decode: ({ inner }) => ({ kind: "not", inner }),
    encode: (n) => ({ inner: n.inner }),
  }),
)

const nary = (kind: "and" | "or", sep: Grammar.Silent, part: Grammar.Grammar<Query>) =>
  Grammar.gen(function* () {
    const first = yield* Grammar.field("first", part)
    const rest = yield* Grammar.field("rest", Grammar.many(Grammar.prefix(sep, part)))
    return { first, rest }
  }).pipe(
    Grammar.transform({
      decode: ({ first, rest }): Query =>
        rest.length === 0 ? first : { kind, parts: [first, ...rest] },
      encode: (q) => {
        if (q.kind === kind) {
          const [first, ...rest] = q.parts
          if (first !== undefined) return { first, rest }
        }
        return { first: q, rest: [] }
      },
    }),
  )

const andSep = Grammar.seq(ws, Grammar.optional(Grammar.seq(Grammar.literal("AND"), ws)))
const andExpr: Grammar.Grammar<Query> = nary("and", andSep, notExpr)

const orSep = Grammar.seq(ws, Grammar.literal("OR"), ws)
const orExpr: Grammar.Grammar<Query> = nary("or", orSep, andExpr)

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
  readonly atom: Schema.ConstraintDecoder<unknown>
  readonly shapes?: ReadonlyArray<QualifierValue["kind"]>
}

const word = (atom: Schema.ConstraintDecoder<unknown>): Spec => ({
  atom,
  shapes: ["word"],
})
const enumOf = <const L extends ReadonlyArray<string>>(values: L): Spec =>
  word(Schema.Literals(values))

const catalog: Record<string, Spec> = {
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
  created: { atom: GithubDate },
  updated: { atom: GithubDate },
  closed: { atom: GithubDate },
  merged: { atom: GithubDate },
  pushed: { atom: GithubDate },
  stars: { atom: GithubNumber },
  forks: { atom: GithubNumber },
  size: { atom: GithubNumber },
  comments: { atom: GithubNumber },
  interactions: { atom: GithubNumber },
  reactions: { atom: GithubNumber },
  commits: { atom: GithubNumber },
  author: { atom: GithubUser },
  assignee: { atom: GithubUser },
  commenter: { atom: GithubUser },
  mentions: { atom: GithubUser },
  involves: { atom: GithubUser },
  "reviewed-by": { atom: GithubUser },
  "review-requested": { atom: GithubUser },
  user: { atom: GithubUser },
  org: { atom: GithubUser },
  repo: { atom: GithubRepo },
  label: { atom: Schema.String },
  milestone: { atom: Schema.String },
  project: { atom: Schema.String },
  language: { atom: Schema.String },
  license: { atom: Schema.String },
  team: { atom: Schema.String },
  head: { atom: Schema.String },
  base: { atom: Schema.String },
  filename: { atom: Schema.String },
  path: { atom: Schema.String },
  extension: { atom: Schema.String },
}

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

const catalogIssues = (q: Query): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  for (const node of walkQualifiers(q)) {
    const spec = catalog[node.key]
    if (spec === undefined) {
      issues.push({ path: [node.key], issue: "unknown qualifier" })
      continue
    }
    if (spec.shapes !== undefined && !spec.shapes.includes(node.value.kind)) {
      issues.push({
        path: [node.key],
        issue: `expected ${spec.shapes.join(" | ")}, got ${node.value.kind}`,
      })
      continue
    }
    for (const a of atoms(node.value)) {
      const r = Schema.decodeUnknownResult(spec.atom)(a)
      if (Result.isFailure(r)) issues.push({ path: [node.key], issue: r.failure.issue })
    }
  }
  return issues
}

const ValidGithubQuery = Grammar.toSchema(whole, QuerySchema, { identifier: "GithubQuery" }).check(
  Schema.makeFilter(catalogIssues),
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const formatIssue = SchemaIssue.makeFormatterDefault()

const samples = [
  "is:pr author:foo label:bug",
  "(author:foo OR author:bar) is:pr -is:archived",
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

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(whole)}\n`)
  for (const source of samples) {
    yield* Schema.decodeUnknownEffect(ValidGithubQuery)(source).pipe(
      Effect.match({
        onSuccess: (value) => `decode ${json(source)}\n  →  ${json(value)}`,
        onFailure: (err) => `decode ${json(source)}\n  →  ${formatIssue(err.issue)}`,
      }),
      Effect.flatMap(Console.log),
    )
  }
  const decoded = yield* Schema.decodeUnknownEffect(ValidGithubQuery)(samples[1]!)
  yield* Console.log(`\nencode  →  ${yield* Schema.encodeEffect(ValidGithubQuery)(decoded)}`)
}).pipe(Effect.runSync)
