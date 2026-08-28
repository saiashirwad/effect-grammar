import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

type JsonValue = null | boolean | number | string | Array<JsonValue> | { [key: string]: JsonValue }

const jsonNull = Grammar.symbol("null").pipe(Grammar.as(null))

const jsonBool = Grammar.choice(
  Grammar.symbol("true").pipe(Grammar.as(true)),
  Grammar.symbol("false").pipe(Grammar.as(false)),
)

const jsonNumber = Grammar.lexeme(
  Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"),
).pipe(Grammar.decodeTo(Schema.Finite)({ decode: Number, encode: String }))

const jsonString = Grammar.lexeme(
  Grammar.regex(/"(?:[^"\\-]|\\(?:["\\\x2fbfnrt]|u[0-9a-fA-F]{4}))*"/, "string"),
).pipe(Grammar.decodeTo(Schema.String)({ decode: JSON.parse, encode: JSON.stringify }))

const jsonValue: Grammar.Grammar<JsonValue> = Grammar.suspend(
  () => Grammar.choice(jsonNull, jsonBool, jsonNumber, jsonString, jsonArray, jsonObject),
  "value",
)

const jsonArray = Grammar.wrap(
  Grammar.symbol("["),
  Grammar.sepBy(jsonValue, Grammar.symbol(",")),
  Grammar.symbol("]"),
)

const member = Grammar.gen(function* () {
  const key = yield* Grammar.field("key", jsonString)
  yield* Grammar.symbol(":")
  const value = yield* Grammar.field("value", jsonValue)
  return { key, value }
})

const jsonObject = Grammar.wrap(
  Grammar.symbol("{"),
  Grammar.sepBy(member, Grammar.symbol(",")),
  Grammar.symbol("}"),
).pipe(
  Grammar.transform({
    decode: (members) => Object.fromEntries(members.map((m) => [m.key, m.value])),
    encode: (object) => Object.entries(object).map(([key, value]) => ({ key, value })),
    is: Schema.is(Schema.Record(Schema.String, Schema.Unknown)),
    name: "object",
  }),
)

const Json = Grammar.toSchema(jsonValue, Schema.Unknown, { identifier: "Json" })

const decode = Schema.decodeEffect(Json)
const encode = Schema.encodeEffect(Json)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const formatIssue = SchemaIssue.makeFormatterDefault()

const document = `{ "name": "ada", "age": 36, "tags": ["math", "code"], "address": { "city": "london", "zip": null } }`

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(jsonValue)}\n`)
  const decoded = yield* decode(document)
  yield* Console.log(`decode  →  ${json(decoded)}`)
  yield* Console.log(`encode  →  ${yield* encode(decoded)}`)
  yield* decode(`[1, 2,`).pipe(
    Effect.match({
      onSuccess: (value) => `decode "[1, 2,"  →  ${json(value)}`,
      onFailure: (err) => `decode "[1, 2,"  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )
}).pipe(Effect.runSync)
