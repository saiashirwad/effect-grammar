import { Console, Effect, Schema } from "effect"

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
  Grammar.regex(/"(?:[^"\\-]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/, "string"),
).pipe(Grammar.decodeTo(Schema.String)({ decode: JSON.parse, encode: JSON.stringify }))

const jsonValue: Grammar.Grammar<JsonValue> = Grammar.suspend(
  () => Grammar.choice(jsonNull, jsonBool, jsonNumber, jsonString, jsonArray, jsonObject),
  "value",
)

const jsonArray = Grammar.gen(function* () {
  yield* Grammar.symbol("[")
  const elements = yield* Grammar.field("elements", Grammar.sepBy(jsonValue, Grammar.symbol(",")))
  yield* Grammar.symbol("]")
  return { elements }
}).pipe(
  Grammar.transform({
    decode: ({ elements }) => elements,
    encode: (elements) => ({ elements }),
    is: Array.isArray,
    name: "array",
  }),
)

const member = Grammar.gen(function* () {
  const key = yield* Grammar.field("key", jsonString)
  yield* Grammar.symbol(":")
  const value = yield* Grammar.field("value", jsonValue)
  return { key, value }
})

const jsonObject = Grammar.gen(function* () {
  yield* Grammar.symbol("{")
  const members = yield* Grammar.field("members", Grammar.sepBy(member, Grammar.symbol(",")))
  yield* Grammar.symbol("}")
  return { members }
}).pipe(
  Grammar.transform({
    decode: ({ members }) => Object.fromEntries(members.map((m) => [m.key, m.value])),
    encode: (object) => ({
      members: Object.entries(object).map(([key, value]) => ({ key, value })),
    }),
    is: (u) => typeof u === "object" && u !== null && !Array.isArray(u),
    name: "object",
  }),
)

const Json = Grammar.toSchema(jsonValue, Schema.Unknown, { identifier: "Json" })

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const document = `{ "name": "ada", "age": 36, "tags": ["math", "code"], "address": { "city": "london", "zip": null } }`

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(jsonValue)}\n`)
  const decoded = yield* Schema.decodeUnknownEffect(Json)(document)
  yield* Console.log(`decode  →  ${json(decoded)}`)
  const encoded = yield* Schema.encodeEffect(Json)(decoded)
  yield* Console.log(`encode  →  ${encoded}`)
  const failed = yield* Effect.result(Schema.decodeUnknownEffect(Json)(`[1, 2,`))
  yield* Console.log(
    `decode "[1, 2,"  →  ${failed._tag === "Failure" ? String(failed.failure) : "?"}`,
  )
}).pipe(Effect.runSync)
