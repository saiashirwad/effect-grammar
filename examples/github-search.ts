/**
 * GitHub search query: grammar owns shape; Schema catalog owns qualifier refinement.
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Result, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

type CompareOp = ">" | ">=" | "<" | "<="

type WordValue = { readonly kind: "word"; readonly value: string }
type QuotedValue = { readonly kind: "quoted"; readonly value: string }
type CompareValue = {
  readonly kind: "compare"
  readonly op: CompareOp
  readonly value: string
}
type RangeValue = {
  readonly kind: "range"
  readonly from: string | undefined
  readonly to: string | undefined
}
type QualifierValue = WordValue | QuotedValue | CompareValue | RangeValue

type Term = {
  readonly kind: "term"
  readonly quoted: boolean
  readonly value: string
}
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

// Parse whitespace; print nothing (significant spaces are AND/OR separators).
const skipWs = Grammar.map(Grammar.regex(/\s*/, "whitespace"), {
  to: () => "",
  from: () => "",
})

const doubleQuoted = Grammar.between(
  Grammar.literal('"'),
  Grammar.literal('"'),
  Grammar.regex(/[^"]*/, "string content"),
)

// Qualifier value shape: compare | range | word | quoted (not a post-parse classify).
const compareOp = Grammar.choice(
  Grammar.literal(">="),
  Grammar.literal("<="),
  Grammar.literal(">"),
  Grammar.literal("<"),
)

const compareValue = Grammar.guard(
  Grammar.attempt(
    Grammar.map(
      Grammar.struct({
        op: compareOp,
        value: Grammar.regex(/[^\s():"']+/, "compare value"),
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
  Grammar.map(Grammar.regex(/[^\s():"']+/, "qualifier value"), {
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

const padded = Grammar.map(Grammar.struct({ ws1: skipWs, inner: query, ws2: skipWs }), {
  to: ({ inner }) => inner,
  from: (inner) => ({ ws1: "", inner, ws2: "" }),
})

const group = Grammar.guard(
  Grammar.map(Grammar.between(Grammar.literal("("), Grammar.literal(")"), padded), {
    to: (inner): Group => ({ kind: "group", inner }),
    from: (g) => g.inner,
  }),
  (v) => v.kind === "group",
)

// Bare words exclude standalone AND/OR/NOT so those stay operators.
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

const term = Grammar.choice(termQuoted, termWord)

// Precedence: NOT > AND (implicit/explicit) > OR. `attempt` rewinds a trailing
// operator so it can belong to the outer level.
const atom = Grammar.choice(qualifier, group, term)

const notExpr: Grammar.Grammar<Query> = Grammar.lazy(() => notExprImpl, { name: "not" })

const notBranch = Grammar.guard(
  Grammar.attempt(
    Grammar.map(
      Grammar.struct({
        kw: Grammar.literal("NOT"),
        ws: Grammar.regex(/\s+/, "whitespace"),
        inner: notExpr,
      }),
      {
        to: ({ inner }): Not => ({ kind: "not", inner }),
        from: (n) => ({ kw: "NOT" as const, ws: " ", inner: n.inner }),
      },
    ),
  ),
  (v) => v.kind === "not",
)

const notExprImpl: Grammar.Grammar<Query> = Grammar.choice(notBranch, atom)

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
    ws: Grammar.regex(/\s+/, "whitespace"),
    op: Grammar.optional(
      Grammar.struct({ kw: Grammar.literal("AND"), ws: Grammar.regex(/\s+/, "whitespace") }),
    ),
  }),
  { to: () => undefined, from: () => ({ ws: " ", op: undefined }) },
)

const andExpr = Grammar.map(
  Grammar.struct({ first: notExpr, rest: Grammar.many(restAfter(andSep, notExpr)) }),
  nary("and"),
)

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

const orExpr = Grammar.map(
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

// Schema atoms for qualifier values (partial dates are not Schema.DateFromString).
const GithubBool = Schema.Literals(["true", "false"])
const GithubNumber = Schema.String.check(
  Schema.isPattern(/^\d+$/, {
    identifier: "GithubNumber",
    message: "expected digits",
  }),
)
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

interface Spec {
  readonly atom: Schema.ConstraintDecoder<unknown>
  /** Allowed value shapes; omit for any. Enums/bools are word-only. */
  readonly shapes?: ReadonlyArray<QualifierValue["kind"]>
}

const wordOnly: ReadonlyArray<QualifierValue["kind"]> = ["word"]

const word = (atom: Schema.ConstraintDecoder<unknown>): Spec => ({
  atom,
  shapes: wordOnly,
})
const anyShape = (atom: Schema.ConstraintDecoder<unknown>): Spec => ({ atom })

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
  created: anyShape(GithubDate),
  updated: anyShape(GithubDate),
  closed: anyShape(GithubDate),
  merged: anyShape(GithubDate),
  pushed: anyShape(GithubDate),
  stars: anyShape(GithubNumber),
  forks: anyShape(GithubNumber),
  size: anyShape(GithubNumber),
  comments: anyShape(GithubNumber),
  interactions: anyShape(GithubNumber),
  reactions: anyShape(GithubNumber),
  commits: anyShape(GithubNumber),
  author: anyShape(GithubUser),
  assignee: anyShape(GithubUser),
  commenter: anyShape(GithubUser),
  mentions: anyShape(GithubUser),
  involves: anyShape(GithubUser),
  "reviewed-by": anyShape(GithubUser),
  "review-requested": anyShape(GithubUser),
  user: anyShape(GithubUser),
  org: anyShape(GithubUser),
  repo: anyShape(GithubRepo),
  label: anyShape(Schema.String),
  milestone: anyShape(Schema.String),
  project: anyShape(Schema.String),
  language: anyShape(Schema.String),
  license: anyShape(Schema.String),
  team: anyShape(Schema.String),
  head: anyShape(Schema.String),
  base: anyShape(Schema.String),
  filename: anyShape(Schema.String),
  path: anyShape(Schema.String),
  extension: anyShape(Schema.String),
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
      if (Result.isFailure(r)) {
        issues.push({ path: [node.key], issue: r.failure.issue })
      }
    }
  }
  return issues
}

const GithubQuery = Grammar.toSchema(whole, Schema.Unknown, {
  identifier: "GithubQuery",
})

const ValidGithubQuery = GithubQuery.check(
  Schema.makeFilter((q: unknown) => catalogIssues(q as Query), {
    identifier: "ValidGithubQuery",
  }),
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

Effect.runSync(Console.log(`grammar:\n${Grammar.render(whole)}\n`))

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
  const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(ValidGithubQuery)(source)))
  Effect.runSync(
    Console.log(
      r._tag === "Success"
        ? `decode ${json(source)}\n  →  ${json(r.success)}`
        : `decode ${json(source)}\n  →  ${SchemaIssue.makeFormatterDefault()(r.failure.issue)}`,
    ),
  )
}

const value = {
  kind: "and" as const,
  parts: [
    {
      kind: "qualifier" as const,
      negate: false,
      key: "is",
      value: { kind: "word" as const, value: "pr" },
    },
    {
      kind: "group" as const,
      inner: {
        kind: "or" as const,
        parts: [
          {
            kind: "qualifier" as const,
            negate: false,
            key: "author",
            value: { kind: "word" as const, value: "foo" },
          },
          {
            kind: "qualifier" as const,
            negate: false,
            key: "author",
            value: { kind: "word" as const, value: "bar" },
          },
        ],
      },
    },
    {
      kind: "qualifier" as const,
      negate: true,
      key: "label",
      value: { kind: "word" as const, value: "wip" },
    },
  ],
}
const encoded = Effect.runSync(Schema.encodeEffect(ValidGithubQuery)(value))
const roundTripped = Effect.runSync(Schema.decodeUnknownEffect(ValidGithubQuery)(encoded))
Effect.runSync(
  Console.log(`\nencode ${json(value)}\n  →  ${encoded}\n  →  decode  →  ${json(roundTripped)}`),
)
