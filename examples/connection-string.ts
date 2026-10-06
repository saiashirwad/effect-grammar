import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const pair = Grammar.gen(function*() {
  const key = yield* Grammar.regex(/[^=&]+/, "param key")
  yield* Grammar.literal("=")
  const value = yield* Grammar.regex(/[^&]*/, "param value")
  return { key, value }
})

const queryParams = pair.pipe(
  Grammar.sepBy("&"),
  Grammar.prefix("?"),
  Grammar.optional,
  Grammar.transform({
    to: Schema.Record(Schema.String, Schema.String),
    decode: (pairs): Record<string, string> => Object.fromEntries((pairs ?? []).map((p) => [p.key, p.value])),
    encode: (record) => {
      const entries = Object.entries(record)
      return entries.length === 0 ? undefined : entries.map(([key, value]) => ({ key, value }))
    },
  }),
  Grammar.filter(Schema.is(Schema.Record(Schema.String, Schema.String)), "query parameters"),
)

const dsn = Grammar.gen(function*() {
  yield* Grammar.literal("postgres://")
  const user = yield* Grammar.regex(/[^:@/?#]+/, "user")
  const password = yield* Grammar.regex(/[^@/?#]+/, "password").pipe(Grammar.prefix(":"), Grammar.optional)
  yield* Grammar.literal("@")
  const host = yield* Grammar.regex(/[^:/?#]+/, "host")
  const port = yield* Grammar.integer.pipe(
    Grammar.filter((n: number) => n >= 1 && n <= 65535, "a port from 1 to 65535"),
    Grammar.prefix(":"),
    Grammar.optional,
  )
  yield* Grammar.literal("/")
  const database = yield* Grammar.regex(/[^/?#]+/, "database")
  const params = yield* queryParams
  return { user, password, host, port, database, params }
})

const Dsn = GrammarSchema.codec(dsn, { identifier: "Dsn" })

const decode = Schema.decodeEffect(Dsn)
const encode = Schema.encodeEffect(Dsn)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const formatIssue = SchemaIssue.makeFormatterDefault()

const samples = [
  "postgres://alice:s3cret@db.internal:5432/shop?sslmode=require&connect_timeout=10",
  "postgres://bob@localhost/postgres",
  "postgres://alice@db.internal:99999/shop",
  "postgres://no-host-at-all",
  "postgres://bob@localhost/postgres#leftover",
]

const value = {
  user: "alice",
  password: "s3cret",
  host: "db.internal",
  port: 5432,
  database: "shop",
  params: { sslmode: "require" },
}

const check = (source: string) =>
  decode(source).pipe(
    Effect.match({
      onSuccess: (value) => `decode ${source}\n  →  ${json(value)}`,
      onFailure: (err) => `decode ${source}\n  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )

Effect.gen(function*() {
  yield* Effect.forEach(samples, check, { discard: true })

  const encoded = yield* encode(value)
  const roundTripped = yield* decode(encoded)
  yield* Console.log(`\nencode ${json(value)}\n  →  ${encoded}\n  →  decode  →  ${json(roundTripped)}`)
}).pipe(Effect.runSync)
