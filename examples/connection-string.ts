import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/grammar.ts"

const user = Grammar.label("user", Grammar.regex(/[^:@/?#]+/, "user"))
const password = Grammar.label("password", Grammar.regex(/[^@/?#]+/, "password"))
const host = Grammar.label("host", Grammar.regex(/[^:/?#]+/, "host"))
const port = Grammar.map(Grammar.label("port", Grammar.regex(/\d+/, "digits")), {
  to: Number,
  from: String,
})
const database = Grammar.label("database", Grammar.regex(/[^/?#]+/, "database"))

const pair = Grammar.map(
  Grammar.struct({
    key: Grammar.label("param key", Grammar.regex(/[^=&]+/, "param key")),
    equals: Grammar.literal("="),
    value: Grammar.label("param value", Grammar.regex(/[^&]*/, "param value")),
  }),
  {
    to: ({ key, value }) => [key, value] as const,
    from: ([key, value]) => ({ key, equals: "=" as const, value }),
  },
)
const params = Grammar.map(Grammar.sepBy(pair, Grammar.literal("&")), {
  to: Object.fromEntries,
  from: Object.entries,
})

const credentials = Grammar.map(
  Grammar.struct({
    user,
    colon: Grammar.optional(Grammar.struct({ sep: Grammar.literal(":"), password })),
  }),
  {
    to: ({ user, colon }) => ({ user, password: colon?.password }),
    from: ({ user, password }) => ({
      user,
      colon: password === undefined ? undefined : { sep: ":" as const, password },
    }),
  },
)

const dsn = Grammar.map(
  Grammar.struct({
    scheme: Grammar.literal("postgres://"),
    credentials,
    at: Grammar.literal("@"),
    host,
    portPart: Grammar.optional(Grammar.struct({ sep: Grammar.literal(":"), port })),
    slash: Grammar.literal("/"),
    database,
    query: Grammar.optional(Grammar.struct({ sep: Grammar.literal("?"), params })),
  }),
  {
    to: ({ credentials, host, portPart, database, query }) => ({
      user: credentials.user,
      password: credentials.password,
      host,
      port: portPart?.port,
      database,
      params: query?.params ?? {},
    }),
    from: ({ user, password, host, port, database, params }) => ({
      scheme: "postgres://" as const,
      credentials: { user, password },
      at: "@" as const,
      host,
      portPart: port === undefined ? undefined : { sep: ":" as const, port },
      slash: "/" as const,
      database,
      query: Object.keys(params).length === 0 ? undefined : { sep: "?" as const, params },
    }),
  },
)

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

Effect.runSync(Console.log(`grammar: ${Grammar.render(dsn)}\n`))

for (const source of [
  "postgres://alice:s3cret@db.internal:5432/shop?sslmode=require&connect_timeout=10",
  "postgres://bob@localhost/postgres",
  "postgres://alice@db.internal:99999/shop",
  "postgres://no-host-at-all",
  "postgres://bob@localhost/postgres#leftover",
]) {
  const r = Effect.runSync(Effect.result(decode(source)))
  Effect.runSync(
    Console.log(
      r._tag === "Success"
        ? `decode ${source}\n  →  ${json(r.success)}`
        : `decode ${source}\n  →  ${String(r.failure)}`,
    ),
  )
}

const value = {
  user: "alice",
  password: "s3cret",
  host: "db.internal",
  port: 5432,
  database: "shop",
  params: { sslmode: "require" },
}
const encoded = Effect.runSync(encode(value))
const roundTripped = Effect.runSync(decode(encoded))
Effect.runSync(
  Console.log(`\nencode ${json(value)}\n  →  ${encoded}\n  →  decode  →  ${json(roundTripped)}`),
)
