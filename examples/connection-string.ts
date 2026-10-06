import { Console, Effect, Schema, SchemaIssue } from "effect"

import { Dsn } from "./grammars/connection-string.ts"

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
  params: [{ key: "sslmode", value: "require" }],
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
