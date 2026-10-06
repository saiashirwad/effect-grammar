import { Console, Effect, Iterable, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

type QualifierValue = Grammar.Type<typeof qualifierValue>
type Term = Grammar.Type<typeof termWord> | Grammar.Type<typeof termQuoted>
type Qualifier = Grammar.Type<typeof qualifier>
type Not = { readonly kind: "not"; readonly inner: Query }
type And = { readonly kind: "and"; readonly parts: ReadonlyArray<Query> }
type Or = { readonly kind: "or"; readonly parts: ReadonlyArray<Query> }
type Group = { readonly kind: "group"; readonly inner: Query }
type AtomicQuery = Term | Qualifier | Not | Group
type Query = AtomicQuery | And | Or

const ws = Grammar.regex(/\s+/, "whitespace").pipe(Grammar.skip(" "))
const token = (expected: string) => Grammar.regex(/[^\s():"']+/, expected)
const doubleQuoted = Grammar.regex(/[^"]*/, "string content").pipe(Grammar.between("\"", "\""))

const compareValue = Grammar.gen(function*() {
  const op = yield* Grammar.literals(">=", "<=", ">", "<")
  const value = yield* token("compare value")
  return { kind: "compare" as const, op, value }
})

const rangeBound = (name: string) => Grammar.optional(Grammar.regex(/(?:(?!\.\.)[^\s():"'])+/, name))

const rangeValue = Grammar.gen(function*() {
  const from = yield* rangeBound("range start")
  yield* Grammar.literal("..")
  const to = yield* rangeBound("range end")
  return { kind: "range" as const, from, to }
})

const wordValue = Grammar.gen(function*() {
  const value = yield* token("qualifier value")
  return { kind: "word" as const, value }
})

const quotedValue = Grammar.gen(function*() {
  const value = yield* doubleQuoted
  return { kind: "quoted" as const, value }
})

const qualifierValue = Grammar.choice([quotedValue, compareValue, rangeValue, wordValue])

const qualifier = Grammar.gen(function*() {
  const negate = yield* Grammar.flag("-")
  const key = yield* Grammar.regex(/[A-Za-z][A-Za-z0-9-]*/, "qualifier name")
  yield* Grammar.literal(":")
  const value = yield* qualifierValue
  return { kind: "qualifier" as const, negate, key, value }
})

const query: Grammar.Grammar<Query> = Grammar.suspend(() => orExpr, "query")

const group = Grammar.gen(function*() {
  const inner = yield* query.pipe(Grammar.between(Grammar.trivia, Grammar.trivia), Grammar.between("(", ")"))
  return { kind: "group" as const, inner }
})

const termWord = Grammar.gen(function*() {
  const value = yield* Grammar.regex(/(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/, "search term")
  return { kind: "term" as const, quoted: false as const, value }
})

const termQuoted = Grammar.gen(function*() {
  const value = yield* doubleQuoted
  return { kind: "term" as const, quoted: true as const, value }
})

const atom = Grammar.choice([qualifier, group, termQuoted, termWord])

const notExpr: Grammar.Grammar<AtomicQuery> = Grammar.suspend(
  () => Grammar.choice([notBranch, atom]),
  "not",
)

const notBranch = Grammar.gen(function*() {
  yield* Grammar.literal("NOT")
  yield* ws
  const inner: Grammar.Ref<Query> = yield* notExpr
  return { kind: "not" as const, inner }
})

const nary = <const Kind extends "and" | "or", Part extends Query>(
  kind: Kind,
  sep: Grammar.Grammar<void>,
  part: Grammar.Grammar<Part>,
) =>
  Grammar.choice([
    Grammar.gen(function*() {
      const parts: Grammar.Ref<ReadonlyArray<Query>> = yield* part.pipe(Grammar.sepBy(sep, { min: 2 }))
      return { kind, parts }
    }),
    part,
  ])

const andSep = Grammar.seq(ws, Grammar.optional(Grammar.seq(Grammar.literal("AND"), ws)))
const andExpr = nary("and", andSep, notExpr)

const orSep = Grammar.seq(ws, Grammar.literal("OR"), ws)
const orExpr = nary("or", orSep, andExpr)

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

interface Spec {
  readonly decode: (atom: string) => Result.Result<unknown, Schema.SchemaError>
  readonly kinds?: ReadonlyArray<QualifierValue["kind"]> | undefined
}

const spec = (atom: Schema.ConstraintDecoder<unknown>, kinds?: ReadonlyArray<QualifierValue["kind"]>): Spec => ({
  decode: Schema.decodeResult(atom),
  kinds,
})
const word = (atom: Schema.ConstraintDecoder<unknown>): Spec => spec(atom, ["word"])
const enumOf = <const L extends ReadonlyArray<string>>(values: L): Spec => word(Schema.Literals(values))

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
  repo: spec(pattern(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "GithubRepo", "expected owner/name")),
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

const walkQualifiers = function*(q: Query): Generator<Qualifier> {
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

const ValidGithubQuery = GrammarSchema.codec(
  query.pipe(Grammar.between(Grammar.trivia, Grammar.trivia)),
  { identifier: "GithubQuery" },
).check(
  Schema.makeFilter((q: Query) => Array.from(Iterable.flatMap(walkQualifiers(q), qualifierIssues))),
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
  "label:\"help wanted\" in:title created:>=2024-01-01 pushed:*..2024-06-30",
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

Effect.gen(function*() {
  yield* Effect.forEach(samples, check, { discard: true })
  const decoded = yield* decode(grouped)
  yield* Console.log(`\nencode  →  ${yield* encode(decoded)}`)
}).pipe(Effect.runSync)
