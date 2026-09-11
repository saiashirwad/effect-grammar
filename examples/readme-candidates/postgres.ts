import { Effect, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect"

import * as Grammar from "../../src/index.ts"

/**
 * A deliberately small, documented subset of PostgreSQL URI connection
 * strings. It uses the `postgres://` scheme, requires user/host/database,
 * permits an optional non-empty password and decimal port, and represents
 * query parameters as a record with unique non-empty keys. Userinfo and the
 * database may use URI percent escapes. IPv6 hosts, `postgresql://`, fragments,
 * duplicate or keyless query parameters, and empty query segments are outside
 * this comparison.
 */
const Host = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]+$/))
const Database = Schema.String.check(Schema.isPattern(/^[^/?#]+$/))
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))
const Params = Schema.Record(Schema.String, Schema.String)

export const PostgresConnectionSchema = Schema.Struct({
  user: Schema.NonEmptyString,
  password: Schema.UndefinedOr(Schema.NonEmptyString),
  host: Host,
  port: Schema.UndefinedOr(Port),
  database: Database,
  params: Params,
})

export type PostgresConnection = typeof PostgresConnectionSchema.Type

const invalid = (
  message: string,
  input: string | PostgresConnection,
  options: SchemaAST.ParseOptions,
) => new SchemaIssue.InvalidValue({ message }, input, options)

const parseQuery = (source: string): Record<string, string> => {
  if (source === "") return {}

  const entries: Array<readonly [string, string]> = []
  const keys = new Set<string>()
  for (const part of source.split("&")) {
    const equals = part.indexOf("=")
    if (part === "" || equals <= 0) throw new Error("query parameters must be key=value pairs")

    const key = decodeURIComponent(part.slice(0, equals).replaceAll("+", " "))
    const value = decodeURIComponent(part.slice(equals + 1).replaceAll("+", " "))
    if (key === "") throw new Error("query parameter keys must not be empty")
    if (keys.has(key)) throw new Error(`duplicate query parameter: ${key}`)
    keys.add(key)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

const encodeQuery = (params: Readonly<Record<string, string>>): string => {
  const keys = Object.keys(params).sort()
  const query = new URLSearchParams()
  for (const key of keys) {
    if (key === "") throw new Error("query parameter keys must not be empty")
    query.set(key, params[key]!)
  }
  return query.toString()
}

const parseManual = (source: string): PostgresConnection => {
  const url = new URL(source)
  if (url.protocol !== "postgres:") throw new Error("expected postgres://")
  if (url.hash !== "") throw new Error("fragments are not supported")
  if (url.username === "") throw new Error("a non-empty user is required")
  if (!Schema.is(Host)(url.hostname)) throw new Error("expected an ASCII hostname")

  // URL exposes an empty password for both an absent and an explicitly empty
  // password. Inspect the authority to reject the latter in this subset.
  const authority = source.slice(source.indexOf("//") + 2).split(/[/?#]/, 1)[0]!
  const userInfo = authority.slice(0, authority.lastIndexOf("@"))
  if (userInfo.includes(":")) {
    if (url.password === "") throw new Error("passwords must not be empty")
  }

  const database = decodeURIComponent(url.pathname.slice(1))
  if (!Schema.is(Database)(database)) {
    throw new Error("expected one non-empty database path segment")
  }

  const port = url.port === "" ? undefined : Number(url.port)
  const result = {
    user: decodeURIComponent(url.username),
    password: url.password === "" ? undefined : decodeURIComponent(url.password),
    host: url.hostname,
    port,
    database,
    params: parseQuery(url.search.slice(1)),
  }
  if (!Schema.is(PostgresConnectionSchema)(result)) {
    throw new Error("invalid PostgreSQL connection values")
  }
  return result
}

const encodeManual = (value: PostgresConnection): string => {
  const url = new URL("postgres://placeholder")
  url.username = value.user
  url.password = value.password ?? ""
  url.hostname = value.host
  url.port = value.port === undefined ? "" : String(value.port)
  url.pathname = `/${encodeURIComponent(value.database)}`
  const query = encodeQuery(value.params)
  url.search = query === "" ? "" : `?${query}`
  return url.href
}

/** The manual baseline uses Effect Schema plus the platform URL implementation. */
export const manualPostgres = Schema.String.pipe(
  Schema.decodeTo(
    PostgresConnectionSchema,
    SchemaTransformation.transformOrFail<PostgresConnection, string>({
      decode: (source, options) => {
        try {
          return Effect.succeed(parseManual(source))
        } catch (error) {
          return Effect.fail(
            invalid(error instanceof Error ? error.message : String(error), source, options),
          )
        }
      },
      encode: (value, options) => {
        try {
          return Effect.succeed(encodeManual(value))
        } catch (error) {
          return Effect.fail(
            invalid(error instanceof Error ? error.message : String(error), value, options),
          )
        }
      },
    }),
  ),
  Schema.annotate({ identifier: "ManualPostgresConnection" }),
)

const encodedUser = Grammar.regex(/[^:@/?#]+/, "user").pipe(
  Grammar.transform({ decode: decodeURIComponent, encode: encodeURIComponent }),
)
const encodedPassword = Grammar.regex(/[^@/?#]+/, "password").pipe(
  Grammar.transform({ decode: decodeURIComponent, encode: encodeURIComponent }),
)
const encodedDatabase = Grammar.regex(/[^/?#]+/, "database").pipe(
  Grammar.transform({ decode: decodeURIComponent, encode: encodeURIComponent }),
)

const query = Grammar.optional(
  Grammar.prefix("?", Grammar.regex(/[^#]*/, "query parameters")),
).pipe(
  Grammar.decodeTo(Params)({
    decode: (source) => parseQuery(source ?? ""),
    encode: (params) => {
      const encoded = encodeQuery(params)
      return encoded === "" ? undefined : encoded
    },
  }),
)

const postgresGrammar = Grammar.gen(function* () {
  yield* Grammar.literal("postgres://")
  const user = yield* encodedUser
  const password = yield* Grammar.optional(Grammar.prefix(":", encodedPassword))
  yield* Grammar.literal("@")
  const host = yield* Grammar.regex(/[A-Za-z0-9.-]+/, "host")
  const port = yield* Grammar.optional(
    Grammar.prefix(
      ":",
      Grammar.regex(/[0-9]+/, "port").pipe(
        Grammar.transform({ decode: Number, encode: String, is: Number.isSafeInteger }),
      ),
    ),
  )
  yield* Grammar.literal("/")
  const database = yield* encodedDatabase
  const params = yield* query
  return { user, password, host, port, database, params }
})

export const grammarPostgres = Grammar.codec(postgresGrammar, PostgresConnectionSchema, {
  identifier: "GrammarPostgresConnection",
})

export { postgresGrammar }
