import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/index.ts"

const pair = Grammar.gen(function* () {
  const key = yield* Grammar.field("key", Grammar.regex(/[^=&]+/, "param key"))
  yield* Grammar.literal("=")
  const value = yield* Grammar.field("value", Grammar.regex(/[^&]*/, "param value"))
  return { key, value }
})

/** `?k=v&k=v` as a record; absent when the record is empty. */
const params = Grammar.optional(Grammar.prefix("?", Grammar.sepBy(pair, "&"))).pipe(
  Grammar.transform({
    decode: (pairs) => Object.fromEntries((pairs ?? []).map((p) => [p.key, p.value])),
    encode: (record: Record<string, string>) => {
      const entries = Object.entries(record)
      return entries.length === 0 ? undefined : entries.map(([key, value]) => ({ key, value }))
    },
  }),
)

const dsn = Grammar.gen(function* () {
  yield* Grammar.literal("postgres://")
  const user = yield* Grammar.field("user", Grammar.regex(/[^:@/?#]+/, "user"))
  const password = yield* Grammar.field(
    "password",
    Grammar.optional(Grammar.prefix(":", Grammar.regex(/[^@/?#]+/, "password"))),
  )
  yield* Grammar.literal("@")
  const host = yield* Grammar.field("host", Grammar.regex(/[^:/?#]+/, "host"))
  const port = yield* Grammar.field("port", Grammar.optional(Grammar.prefix(":", Grammar.integer)))
  yield* Grammar.literal("/")
  const database = yield* Grammar.field("database", Grammar.regex(/[^/?#]+/, "database"))
  const query = yield* Grammar.field("params", params)
  return { user, password, host, port, database, params: query }
})

const ConnectionInfo = Schema.Struct({
  user: Schema.NonEmptyString,
  password: Schema.UndefinedOr(Schema.String),
  host: Schema.NonEmptyString,
  port: Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  database: Schema.NonEmptyString,
  params: Schema.Record(Schema.String, Schema.String),
})
const Dsn = Grammar.toSchema(dsn, ConnectionInfo, { identifier: "Dsn" })

const decode = Schema.decodeUnknownEffect(Dsn)
const encode = Schema.encodeEffect(Dsn)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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

Effect.gen(function* () {
  yield* Console.log(`grammar: ${Grammar.render(dsn)}\n`)

  for (const source of samples) {
    const r = yield* Effect.result(decode(source))
    yield* Console.log(
      r._tag === "Success"
        ? `decode ${source}\n  →  ${json(r.success)}`
        : `decode ${source}\n  →  ${String(r.failure)}`,
    )
  }

  const encoded = yield* encode(value)
  const roundTripped = yield* decode(encoded)
  yield* Console.log(
    `\nencode ${json(value)}\n  →  ${encoded}\n  →  decode  →  ${json(roundTripped)}`,
  )
}).pipe(Effect.runSync)
