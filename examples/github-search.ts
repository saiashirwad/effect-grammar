/**
 * GitHub search query: grammar owns shape; catalog owns qualifier refinement.
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Equal, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

type CompareOp = ">" | ">=" | "<" | "<="

type QualifierValue =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "quoted"; readonly value: string }
  | { readonly kind: "compare"; readonly op: CompareOp; readonly value: string }
  | { readonly kind: "range"; readonly from: string | undefined; readonly to: string | undefined }

interface Term {
  readonly kind: "term"
  readonly quoted: boolean
  readonly value: string
}
interface Qualifier {
  readonly kind: "qualifier"
  readonly negate: boolean
  readonly key: string
  readonly value: QualifierValue
}
interface Not {
  readonly kind: "not"
  readonly inner: Query
}
interface And {
  readonly kind: "and"
  readonly parts: ReadonlyArray<Query>
}
interface Or {
  readonly kind: "or"
  readonly parts: ReadonlyArray<Query>
}
interface Group {
  readonly kind: "group"
  readonly inner: Query
}

type Query = Term | Qualifier | Not | And | Or | Group

type QuotedValue = Extract<QualifierValue, { readonly kind: "quoted" }>

/** Parse `\s*`; print nothing. */
const skipWs: Grammar.Grammar<string> = Grammar.map(Grammar.regex(/\s*/, "whitespace"), {
  to: (ws) => ws,
  from: () => "",
})

const isCompareOp = (s: string): s is CompareOp =>
  s === ">" || s === ">=" || s === "<" || s === "<="

const classify = (raw: string): QualifierValue => {
  const cmp = /^(>=|<=|>|<)(.+)$/.exec(raw)
  if (cmp !== null) {
    const op = cmp[1]
    const value = cmp[2]
    if (op !== undefined && value !== undefined && isCompareOp(op)) {
      return { kind: "compare", op, value }
    }
  }
  const rng = /^(.*)\.\.(.*)$/.exec(raw)
  if (rng !== null) {
    const from = rng[1] ?? ""
    const to = rng[2] ?? ""
    return {
      kind: "range",
      from: from === "" ? undefined : from,
      to: to === "" ? undefined : to,
    }
  }
  return { kind: "word", value: raw }
}

const stringify = (v: QualifierValue): string => {
  switch (v.kind) {
    case "word":
    case "quoted":
      return v.value
    case "compare":
      return v.op + v.value
    case "range":
      return (v.from ?? "") + ".." + (v.to ?? "")
  }
}

const rawValue = Grammar.guard(
  Grammar.map(Grammar.regex(/[^\s():"']+/, "qualifier value"), {
    to: classify,
    from: stringify,
  }),
  (v) => v.kind !== "quoted",
)

const quotedValue = Grammar.guard(
  Grammar.map(
    Grammar.struct({
      open: Grammar.literal('"'),
      inner: Grammar.regex(/[^"]*/, "string content"),
      close: Grammar.literal('"'),
    }),
    {
      to: ({ inner }): QualifierValue => ({ kind: "quoted", value: inner }),
      from: (v) => {
        const q = v as QuotedValue
        return { open: '"' as const, inner: q.value, close: '"' as const }
      },
    },
  ),
  (v) => v.kind === "quoted",
)

const qualifierValue = Grammar.choice(quotedValue, rawValue)

const qualifierKey = Grammar.regex(/[A-Za-z][A-Za-z0-9-]*/, "qualifier name")

const qualifier = Grammar.attempt(
  Grammar.guard(
    Grammar.map(
      Grammar.struct({
        neg: Grammar.optional(Grammar.literal("-")),
        key: qualifierKey,
        colon: Grammar.literal(":"),
        value: qualifierValue,
      }),
      {
        to: ({ neg, key, value }): Query => ({
          kind: "qualifier",
          negate: neg !== undefined,
          key,
          value,
        }),
        from: (q) => {
          const n = q as Qualifier
          return {
            neg: n.negate ? ("-" as const) : undefined,
            key: n.key,
            colon: ":" as const,
            value: n.value,
          }
        },
      },
    ),
    (v) => v.kind === "qualifier",
  ),
)

const query: Grammar.Grammar<Query> = Grammar.lazy(() => orExpr, { name: "query" })

const group = Grammar.guard(
  Grammar.map(
    Grammar.struct({
      open: Grammar.literal("("),
      ws1: skipWs,
      inner: query,
      ws2: skipWs,
      close: Grammar.literal(")"),
    }),
    {
      to: ({ inner }): Query => ({ kind: "group", inner }),
      from: (g) => {
        const n = g as Group
        return {
          open: "(" as const,
          ws1: "",
          inner: n.inner,
          ws2: "",
          close: ")" as const,
        }
      },
    },
  ),
  (v) => v.kind === "group",
)

// Bare words exclude standalone AND/OR/NOT so those stay operators.
const termWord = Grammar.guard(
  Grammar.map(Grammar.regex(/(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/, "search term"), {
    to: (value): Query => ({ kind: "term", quoted: false, value }),
    from: (t) => (t as Term).value,
  }),
  (v) => v.kind === "term" && !v.quoted,
)

const termQuoted = Grammar.guard(
  Grammar.map(
    Grammar.struct({
      open: Grammar.literal('"'),
      inner: Grammar.regex(/[^"]*/, "string content"),
      close: Grammar.literal('"'),
    }),
    {
      to: ({ inner }): Query => ({ kind: "term", quoted: true, value: inner }),
      from: (t) => {
        const n = t as Term
        return { open: '"' as const, inner: n.value, close: '"' as const }
      },
    },
  ),
  (v) => v.kind === "term" && v.quoted,
)

const term = Grammar.choice(termQuoted, termWord)

// Precedence: NOT > AND (implicit/explicit) > OR. `attempt` rewinds a trailing
// operator so it can belong to the outer level.
const atom = Grammar.choice(qualifier, group, term)

const notExpr: Grammar.Grammar<Query> = Grammar.lazy(() => notExprImpl, { name: "not" })

const notBranch: Grammar.Grammar<Query> = Grammar.guard(
  Grammar.attempt(
    Grammar.map(
      Grammar.struct({
        kw: Grammar.literal("NOT"),
        ws: Grammar.regex(/\s+/, "whitespace"),
        inner: notExpr,
      }),
      {
        to: ({ inner }): Query => ({ kind: "not", inner }),
        from: (n) => {
          const v = n as Not
          return { kw: "NOT" as const, ws: " ", inner: v.inner }
        },
      },
    ),
  ),
  (v) => v.kind === "not",
)

const notExprImpl: Grammar.Grammar<Query> = Grammar.choice(notBranch, atom)

const andSep = Grammar.map(
  Grammar.struct({
    ws: Grammar.regex(/\s+/, "whitespace"),
    op: Grammar.optional(
      Grammar.struct({ kw: Grammar.literal("AND"), ws: Grammar.regex(/\s+/, "whitespace") }),
    ),
  }),
  { to: () => undefined, from: () => ({ ws: " ", op: undefined }) },
)

const andRest = Grammar.attempt(
  Grammar.map(Grammar.struct({ sep: andSep, atom: notExpr }), {
    to: ({ atom }): Query => atom,
    from: (atom) => ({ sep: undefined, atom }),
  }),
)

const andExpr = Grammar.map(Grammar.struct({ first: notExpr, rest: Grammar.many(andRest) }), {
  to: ({ first, rest }): Query =>
    rest.length === 0 ? first : { kind: "and", parts: [first, ...rest] },
  from: (q) => {
    if (q.kind === "and") {
      const [first, ...rest] = q.parts
      if (first !== undefined) return { first, rest }
    }
    return { first: q, rest: [] }
  },
})

const orSep = Grammar.map(
  Grammar.struct({
    ws1: Grammar.regex(/\s+/, "whitespace"),
    kw: Grammar.literal("OR"),
    ws2: Grammar.regex(/\s+/, "whitespace"),
  }),
  {
    to: () => undefined,
    from: () => ({ ws1: " ", kw: "OR" as const, ws2: " " }),
  },
)

const orRest = Grammar.attempt(
  Grammar.map(Grammar.struct({ sep: orSep, atom: andExpr }), {
    to: ({ atom }): Query => atom,
    from: (atom) => ({ sep: undefined, atom }),
  }),
)

const orExpr = Grammar.map(Grammar.struct({ first: andExpr, rest: Grammar.many(orRest) }), {
  to: ({ first, rest }): Query =>
    rest.length === 0 ? first : { kind: "or", parts: [first, ...rest] },
  from: (q) => {
    if (q.kind === "or") {
      const [first, ...rest] = q.parts
      if (first !== undefined) return { first, rest }
    }
    return { first: q, rest: [] }
  },
})

const whole = Grammar.map(
  Grammar.struct({ ws1: skipWs, q: query, ws2: skipWs, end: Grammar.end }),
  {
    to: ({ q }) => q,
    from: (q) => ({ ws1: "", ws2: "", q, end: undefined }),
  },
)

export const parse = (input: string) => Grammar.parse(input, whole)
export const print = (q: Query) => Grammar.print(whole, q)
export const render = () => Grammar.render(whole)

const formatIssue = SchemaIssue.makeFormatterDefault()

const wordOnly: ReadonlyArray<QualifierValue["kind"]> = ["word"]

const GithubBool = Schema.Literals(["true", "false"])
const GithubNumber = Schema.String.check(
  Schema.isPattern(/^\d+$/, {
    identifier: "GithubNumber",
    message: "expected digits",
  }),
)
// Partial dates: YYYY, YYYY-MM, or YYYY-MM-DD (not Schema.DateFromString).
const GithubDate = Schema.String.check(
  Schema.isPattern(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/, {
    identifier: "GithubDate",
    message: "expected a date (YYYY[-MM[-DD]])",
  }),
)
const GithubUser = Schema.Union([
  Schema.Literal("@me"),
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, {
      identifier: "GithubUser",
      message: "expected a GitHub username",
    }),
  ),
])
const GithubRepo = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, {
    identifier: "GithubRepo",
    message: "expected owner/name",
  }),
)
const GithubText = Schema.String

interface Spec {
  /** Schema for each string atom in the qualifier value. */
  readonly atom: Schema.ConstraintDecoder<unknown>
  /** Allowed value shapes; default is any. Enum/boolean are word-only. */
  readonly shapes?: ReadonlyArray<QualifierValue["kind"]>
}

const enumOf = <const L extends ReadonlyArray<string>>(values: L): Spec => ({
  atom: Schema.Literals(values),
  shapes: wordOnly,
})

const boolSpec: Spec = { atom: GithubBool, shapes: wordOnly }
const numberSpec: Spec = { atom: GithubNumber }
const dateSpec: Spec = { atom: GithubDate }
const userSpec: Spec = { atom: GithubUser }
const repoSpec: Spec = { atom: GithubRepo }
const textSpec: Spec = { atom: GithubText }

/** Representative GitHub qualifiers; unknown keys fail validation. */
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
  archived: boolSpec,
  draft: boolSpec,
  locked: boolSpec,
  created: dateSpec,
  updated: dateSpec,
  closed: dateSpec,
  merged: dateSpec,
  pushed: dateSpec,
  stars: numberSpec,
  forks: numberSpec,
  size: numberSpec,
  comments: numberSpec,
  interactions: numberSpec,
  reactions: numberSpec,
  commits: numberSpec,
  author: userSpec,
  assignee: userSpec,
  commenter: userSpec,
  mentions: userSpec,
  involves: userSpec,
  "reviewed-by": userSpec,
  "review-requested": userSpec,
  user: userSpec,
  org: userSpec,
  repo: repoSpec,
  label: textSpec,
  milestone: textSpec,
  project: textSpec,
  language: textSpec,
  license: textSpec,
  team: textSpec,
  head: textSpec,
  base: textSpec,
  filename: textSpec,
  path: textSpec,
  extension: textSpec,
}

/** String atoms in a value (`*` range ends are open, not data). */
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

/** Schema issues for one qualifier (no key prefix — path carries the key). */
const checkQualifier = (q: Qualifier): ReadonlyArray<string> => {
  const spec = catalog[q.key]
  if (spec === undefined) return [`unknown qualifier`]

  if (spec.shapes !== undefined && !spec.shapes.includes(q.value.kind)) {
    return [`expected a single value, got ${q.value.kind}`]
  }

  const out: Array<string> = []
  for (const a of atoms(q.value)) {
    const r = Schema.decodeUnknownResult(spec.atom)(a)
    if (Result.isFailure(r)) out.push(formatIssue(r.failure.issue))
  }
  return out
}

/** Human-readable catalog problems on a parsed query. */
export const validate = (q: Query): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const node of walkQualifiers(q)) {
    for (const msg of checkQualifier(node)) out.push(`${node.key}: ${msg}`)
  }
  return out
}

export const GithubQuery = Grammar.toSchema(whole, Schema.Unknown, {
  identifier: "GithubQuery",
})

/** Structure from the grammar; values refined by the Schema catalog. */
export const ValidGithubQuery = GithubQuery.check(
  Schema.makeFilter(
    (q: unknown) => {
      const issues: Array<Schema.FilterIssue> = []
      for (const node of walkQualifiers(q as Query)) {
        for (const msg of checkQualifier(node)) {
          issues.push({ path: [node.key], issue: msg })
        }
      }
      return issues
    },
    { identifier: "ValidGithubQuery" },
  ),
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const samples: Array<string> = [
  "is:pr author:foo label:bug",
  "(author:foo OR author:bar) is:pr -is:archived",
  "NOT draft:true stars:10..1000 language:TypeScript",
  'label:"help wanted" in:title created:>=2024-01-01 pushed:*..2024-06-30',
  "repo:effect-ts/effect path:src extension:ts",
  // refinement failures:
  "is:maybe",
  "stars:abc",
  "created:2020-13-99",
  "frobnicate:x",
  "repo:notasluginthere",
  // parse failures:
  "is:pr (unclosed",
  "is:",
]

const run = Effect.gen(function* () {
  yield* Console.log(`grammar:\n${render()}\n`)

  for (const src of samples) {
    const r = yield* Effect.result(parse(src))
    if (r._tag === "Failure") {
      yield* Console.log(`parse  ${json(src)}\n        → ${r.failure.message}`)
      continue
    }
    const ast = r.success
    const printed = yield* print(ast)
    const issues = validate(ast)
    const ok = issues.length === 0 ? "ok" : issues.join("; ")
    yield* Console.log(
      `parse  ${json(src)}\n        ast   ${json(ast)}\n        print ${json(printed)}\n        check ${ok}`,
    )
  }

  const built: Query = {
    kind: "and",
    parts: [
      { kind: "qualifier", negate: false, key: "is", value: { kind: "word", value: "pr" } },
      {
        kind: "group",
        inner: {
          kind: "or",
          parts: [
            {
              kind: "qualifier",
              negate: false,
              key: "author",
              value: { kind: "word", value: "foo" },
            },
            {
              kind: "qualifier",
              negate: false,
              key: "author",
              value: { kind: "word", value: "bar" },
            },
          ],
        },
      },
      { kind: "qualifier", negate: true, key: "label", value: { kind: "word", value: "wip" } },
    ],
  }
  const asString = yield* print(built)
  const back = yield* parse(asString)
  yield* Console.log(
    `\nround-trip ${json(asString)} → ${Equal.equals(back, built) ? "equal" : "MISMATCH"}`,
  )

  for (const bad of ["is:maybe", "stars:abc", "repo:notasluginthere"] as const) {
    const decoded = yield* Effect.result(Schema.decodeUnknownEffect(ValidGithubQuery)(bad))
    const msg = decoded._tag === "Success" ? "accepted" : formatIssue(decoded.failure.issue)
    yield* Console.log(`schema   decode ${json(bad)} → ${msg}`)
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  Effect.runSync(run)
}
