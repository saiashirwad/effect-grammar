import * as Grammar from "../../src/index.ts"
import * as GrammarSchema from "../../src/schema.ts"

const pair = Grammar.gen(function*() {
  const key = yield* Grammar.regex(/[^=&]+/, "param key")
  yield* Grammar.literal("=")
  const value = yield* Grammar.regex(/[^&]*/, "param value")
  return { key, value }
})

export const dsn = Grammar.gen(function*() {
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
  const params = yield* pair.pipe(Grammar.sepBy("&"), Grammar.prefix("?"), Grammar.optional)
  return { user, password, host, port, database, params }
})

export const Dsn = GrammarSchema.codec(dsn, { identifier: "Dsn" })
