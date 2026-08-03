/**
 * GitHub search query: grammar owns shape; Schema catalog owns qualifier refinement.
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

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

const skipWs = Grammar.map(Grammar.regex(/\s*/, "whitespace"), {
  to: () => "",
  from: () => "",
})
const ws = Grammar.regex(/\s+/, "whitespace")
const token = (expected: string) => Grammar.regex(/[^\s():"']+/, expected)
const doubleQuoted = Grammar.between(
  Grammar.literal('"'),
  Grammar.literal('"'),
  Grammar.regex(/[^"]*/, "string content"),
)

type WordValue = Extract<QualifierValue, { readonly kind: "word" }>
type QuotedValue = Extract<QualifierValue, { readonly kind: "quoted" }>
type CompareValue = Extract<QualifierValue, { readonly kind: "compare" }>
type RangeValue = Extract<QualifierValue, { readonly kind: "range" }>

const compareValue = Grammar.guard(
  Grammar.attempt(
    Grammar.map(
      Grammar.struct({
        op: Grammar.choice(
          Grammar.literal(">="),
          Grammar.literal("<="),
          Grammar.literal(">"),
          Grammar.literal("<"),
        ),
        value: token("compare value"),
      }),
      {
        to: ({ op, value }): CompareValue => ({ kind: "compare", op, value }),
        from: (v) => ({ op: v.op, value: v.value }),
      },
    ),
  ),
  (v) => v.kind === "compare",
)

const rangeValue = Grammar.guard(
  Grammar.map(Grammar.regex(/[^\s():"']*\.\.[^\s():"']*/, "range"), {
    to: (raw): RangeValue => {
      const i = raw.indexOf("..")
      const from = raw.slice(0, i)
      const to = raw.slice(i + 2)
      return {
        kind: "range",
        from: from === "" ? undefined : from,
        to: to === "" ? undefined : to,
      }
    },
    from: (v) => (v.from ?? "") + ".." + (v.to ?? ""),
  }),
  (v) => v.kind === "range",
)

const wordValue = Grammar.guard(
  Grammar.map(token("qualifier value"), {
    to: (value): WordValue => ({ kind: "word", value }),
    from: (v) => v.value,
  }),
  (v) => v.kind === "word",
)

const quotedValue = Grammar.guard(
  Grammar.map(doubleQuoted, {
    to: (value): QuotedValue => ({ kind: "quoted", value }),
    from: (v) => v.value,
  }),
  (v) => v.kind === "quoted",
)

const qualifierValue = Grammar.choice(quotedValue, compareValue, rangeValue, wordValue)

const qualifier = Grammar.attempt(
  Grammar.guard(
    Grammar.map(
      Grammar.struct({
        neg: Grammar.optional(Grammar.literal("-")),
        key: Grammar.regex(/[A-Za-z][A-Za-z0-9-]*/, "qualifier name"),
        colon: Grammar.literal(":"),
        value: qualifierValue,
      }),
      {
        to: ({ neg, key, value }): Qualifier => ({
          kind: "qualifier",
          negate: neg !== undefined,
          key,
          value,
        }),
        from: (q) => ({
          neg: q.negate ? ("-" as const) : undefined,
          key: q.key,
          colon: ":" as const,
          value: q.value,
        }),
      },
    ),
    (v) => v.kind === "qualifier",
  ),
)

const query: Grammar.Grammar<Query> = Grammar.lazy(() => orExpr, { name: "query" })

const group: Grammar.Grammar<Group> = Grammar.guard(
  Grammar.map(
    Grammar.between(
      Grammar.literal("("),
      Grammar.literal(")"),
      Grammar.map(Grammar.struct({ ws1: skipWs, inner: query, ws2: skipWs }), {
        to: ({ inner }) => inner,
        from: (inner) => ({ ws1: "", inner, ws2: "" }),
      }),
    ),
    {
      to: (inner): Group => ({ kind: "group", inner }),
      from: (g) => g.inner,
    },
  ),
  (v) => v.kind === "group",
)

const termWord = Grammar.guard(
  Grammar.map(Grammar.regex(/(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/, "search term"), {
    to: (value): Term => ({ kind: "term", quoted: false, value }),
    from: (t) => t.value,
  }),
  (v) => v.kind === "term" && !v.quoted,
)

const termQuoted = Grammar.guard(
  Grammar.map(doubleQuoted, {
    to: (value): Term => ({ kind: "term", quoted: true, value }),
    from: (t) => t.value,
  }),
  (v) => v.kind === "term" && v.quoted,
)

const atom: Grammar.Grammar<Query> = Grammar.choice(qualifier, group, termQuoted, termWord)

// Precedence: NOT > AND > OR. `attempt` rewinds a trailing op for the outer level.
const notExpr: Grammar.Grammar<Query> = Grammar.lazy(() => Grammar.choice(notBranch, atom), {
  name: "not",
})

const notBranch: Grammar.Grammar<Not> = Grammar.guard(
  Grammar.attempt(
    Grammar.map(Grammar.struct({ kw: Grammar.literal("NOT"), ws, inner: notExpr }), {
      to: ({ inner }): Not => ({ kind: "not", inner }),
      from: (n) => ({ kw: "NOT" as const, ws: " ", inner: n.inner }),
    }),
  ),
  (v) => v.kind === "not",
)

const restAfter = <A>(
  sep: Grammar.Grammar<undefined>,
  atom: Grammar.Grammar<A>,
): Grammar.Grammar<A> =>
  Grammar.attempt(
    Grammar.map(Grammar.struct({ sep, atom }), {
      to: ({ atom }) => atom,
      from: (atom) => ({ sep: undefined, atom }),
    }),
  )

const nary = (kind: "and" | "or") => ({
  to: ({ first, rest }: { first: Query; rest: ReadonlyArray<Query> }): Query =>
    rest.length === 0 ? first : { kind, parts: [first, ...rest] },
  from: (q: Query) => {
    if (q.kind === kind) {
      const [first, ...rest] = q.parts
      if (first !== undefined) return { first, rest }
    }
    return { first: q, rest: [] as Array<Query> }
  },
})

const andSep = Grammar.map(
  Grammar.struct({
    ws,
    op: Grammar.optional(Grammar.struct({ kw: Grammar.literal("AND"), ws })),
  }),
  { to: () => undefined, from: () => ({ ws: " ", op: undefined }) },
)

const andExpr: Grammar.Grammar<Query> = Grammar.map(
  Grammar.struct({ first: notExpr, rest: Grammar.many(restAfter(andSep, notExpr)) }),
  nary("and"),
)

const orSep = Grammar.map(Grammar.struct({ ws1: ws, kw: Grammar.literal("OR"), ws2: ws }), {
  to: () => undefined,
  from: () => ({ ws1: " ", kw: "OR" as const, ws2: " " }),
})

const orExpr: Grammar.Grammar<Query> = Grammar.map(
  Grammar.struct({ first: andExpr, rest: Grammar.many(restAfter(orSep, andExpr)) }),
  nary("or"),
)

const whole = Grammar.map(
  Grammar.struct({ ws1: skipWs, q: query, ws2: skipWs, end: Grammar.end }),
  {
    to: ({ q }) => q,
    from: (q) => ({ ws1: "", ws2: "", q, end: undefined }),
  },
)

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

// AST schema: Encoded/Type = Query so Grammar.toSchema is typed (not Schema.Unknown).
const QualifierValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("quoted"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("compare"),
    op: Schema.Literals([">", ">=", "<", "<="]),
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    from: Schema.UndefinedOr(Schema.String),
    to: Schema.UndefinedOr(Schema.String),
  }),
])

const QuerySchema: Schema.Codec<Query> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("term"),
    quoted: Schema.Boolean,
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("qualifier"),
    negate: Schema.Boolean,
    key: Schema.String,
    value: QualifierValueSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("not"),
    inner: Schema.suspend((): Schema.Codec<Query> => QuerySchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("and"),
    parts: Schema.Array(Schema.suspend((): Schema.Codec<Query> => QuerySchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("or"),
    parts: Schema.Array(Schema.suspend((): Schema.Codec<Query> => QuerySchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    inner: Schema.suspend((): Schema.Codec<Query> => QuerySchema),
  }),
])

const ValidGithubQuery = Grammar.toSchema(whole, QuerySchema, { identifier: "GithubQuery" }).check(
  Schema.makeFilter(catalogIssues, { identifier: "ValidGithubQuery" }),
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const formatIssue = SchemaIssue.makeFormatterDefault()

Effect.gen(function* () {
  for (const source of [
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
  ]) {
    const r = yield* Effect.result(Schema.decodeUnknownEffect(ValidGithubQuery)(source))
    if (r._tag === "Success") {
      yield* Console.log(`decode ${json(source)}\n  →  ${json(r.success)}`)
    } else {
      yield* Console.log(`decode ${json(source)}\n  →  ${formatIssue(r.failure.issue)}`)
    }
  }
}).pipe(Effect.runFork)
