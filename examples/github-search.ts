/**
 * GitHub search query: grammar owns shape; catalog owns qualifier refinement.
 * Spec: https://docs.github.com/en/search-github
 */
import { Console, Effect, Equal, Schema } from "effect"

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
  Grammar.map(
    Grammar.regex(/(?!(?:AND|OR|NOT)(?:$|\s|[()]))[^\s():"']+/, "search term"),
    {
      to: (value): Query => ({ kind: "term", quoted: false, value }),
      from: (t) => (t as Term).value,
    },
  ),
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
  Grammar.map(
    Grammar.struct({ sep: andSep, atom: notExpr }),
    {
      to: ({ atom }): Query => atom,
      from: (atom) => ({ sep: undefined, atom }),
    },
  ),
)

const andExpr = Grammar.map(
  Grammar.struct({ first: notExpr, rest: Grammar.many(andRest) }),
  {
    to: ({ first, rest }): Query =>
      rest.length === 0 ? first : { kind: "and", parts: [first, ...rest] },
    from: (q) => {
      if (q.kind === "and") {
        const [first, ...rest] = q.parts
        if (first !== undefined) return { first, rest }
      }
      return { first: q, rest: [] }
    },
  },
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

const orRest = Grammar.attempt(
  Grammar.map(
    Grammar.struct({ sep: orSep, atom: andExpr }),
    {
      to: ({ atom }): Query => atom,
      from: (atom) => ({ sep: undefined, atom }),
    },
  ),
)

const orExpr = Grammar.map(
  Grammar.struct({ first: andExpr, rest: Grammar.many(orRest) }),
  {
    to: ({ first, rest }): Query =>
      rest.length === 0 ? first : { kind: "or", parts: [first, ...rest] },
    from: (q) => {
      if (q.kind === "or") {
        const [first, ...rest] = q.parts
        if (first !== undefined) return { first, rest }
      }
      return { first: q, rest: [] }
    },
  },
)

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

type ValueKind = "boolean" | "enum" | "date" | "number" | "user" | "repo" | "label" | "text"

interface Spec {
  readonly kind: ValueKind
  readonly values?: ReadonlyArray<string>
}

/** Representative GitHub qualifiers; unknown keys fail `validate`. */
const catalog: Record<string, Spec> = {
  is: {
    kind: "enum",
    values: [
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
    ],
  },
  state: { kind: "enum", values: ["open", "closed"] },
  type: { kind: "enum", values: ["pr", "issue", "repositories", "commits"] },
  status: { kind: "enum", values: ["pending", "success", "failure", "neutral"] },
  review: {
    kind: "enum",
    values: ["none", "required", "approved", "changes_requested", "dismissed"],
  },
  linked: { kind: "enum", values: ["issue", "pr"] },
  visibility: { kind: "enum", values: ["public", "private", "internal"] },
  in: { kind: "enum", values: ["title", "body", "comments", "file", "path"] },
  no: { kind: "enum", values: ["label", "milestone", "assignee", "project"] },
  archived: { kind: "boolean" },
  draft: { kind: "boolean" },
  locked: { kind: "boolean" },
  created: { kind: "date" },
  updated: { kind: "date" },
  closed: { kind: "date" },
  merged: { kind: "date" },
  pushed: { kind: "date" },
  stars: { kind: "number" },
  forks: { kind: "number" },
  size: { kind: "number" },
  comments: { kind: "number" },
  interactions: { kind: "number" },
  reactions: { kind: "number" },
  commits: { kind: "number" },
  author: { kind: "user" },
  assignee: { kind: "user" },
  commenter: { kind: "user" },
  mentions: { kind: "user" },
  involves: { kind: "user" },
  "reviewed-by": { kind: "user" },
  "review-requested": { kind: "user" },
  user: { kind: "user" },
  org: { kind: "user" },
  repo: { kind: "repo" },
  label: { kind: "label" },
  milestone: { kind: "label" },
  project: { kind: "label" },
  language: { kind: "label" },
  license: { kind: "label" },
  team: { kind: "text" },
  head: { kind: "text" },
  base: { kind: "text" },
  filename: { kind: "text" },
  path: { kind: "text" },
  extension: { kind: "text" },
}

const isDate = (s: string) => {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s)
  if (m === null) return false
  const month = m[2]
  const day = m[3]
  if (month !== undefined && (month < "01" || month > "12")) return false
  if (day !== undefined && (day < "01" || day > "31")) return false
  return true
}
const isNumber = (s: string) => /^\d+$/.test(s)
const isUser = (s: string) =>
  s === "@me" || /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(s)
const isRepo = (s: string) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)

const valuePred: Partial<Record<ValueKind, (s: string) => boolean>> = {
  date: isDate,
  number: isNumber,
  user: isUser,
  repo: isRepo,
}

/** Value atoms (`*` range ends are open, not data). */
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

const validateQualifier = (q: Qualifier): string | null => {
  const spec = catalog[q.key]
  if (!spec) return `unknown qualifier "${q.key}"`

  if ((spec.kind === "enum" || spec.kind === "boolean") && q.value.kind !== "word") {
    return `${q.key}: expected a single value, got ${q.value.kind}`
  }
  if (
    spec.kind === "boolean" &&
    !(q.value.kind === "word" && (q.value.value === "true" || q.value.value === "false"))
  ) {
    return `${q.key}: expected true or false`
  }
  if (spec.kind === "enum") {
    const allowed = spec.values
    if (q.value.kind === "word" && allowed !== undefined && !allowed.includes(q.value.value)) {
      return `${q.key}: expected one of ${allowed.join(", ")}`
    }
  }
  const pred = valuePred[spec.kind]
  if (pred !== undefined) {
    for (const a of atoms(q.value)) {
      if (!pred(a)) return `${q.key}: invalid value "${a}"`
    }
  }
  return null
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

export const validate = (q: Query): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const node of walkQualifiers(q)) {
    const err = validateQualifier(node)
    if (err !== null) out.push(err)
  }
  return out
}

export const GithubQuery = Grammar.toSchema(whole, Schema.Unknown, {
  identifier: "GithubQuery",
})

export const ValidGithubQuery = GithubQuery.pipe(
  Schema.refine((q): q is Query => validate(q as Query).length === 0, {
    message: "invalid GitHub search query",
    identifier: "ValidGithubQuery",
  }),
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

  const decoded = yield* Effect.result(
    Schema.decodeUnknownEffect(ValidGithubQuery)("is:maybe"),
  )
  yield* Console.log(
    `schema   decode "is:maybe" → ${decoded._tag === "Success" ? "accepted" : "rejected (refinement)"}`,
  )
})

if (import.meta.url === `file://${process.argv[1]}`) {
  Effect.runSync(run)
}
