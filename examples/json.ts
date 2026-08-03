import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/grammar.ts"

type JsonValue = null | boolean | number | string | Array<JsonValue> | { [key: string]: JsonValue }

const jsonNull = Grammar.mapSchema(Grammar.symbol("null"), Schema.Null, {
  to: () => null,
  from: () => "null" as const,
})
const jsonBool = Grammar.mapSchema(
  Grammar.choice(Grammar.symbol("true"), Grammar.symbol("false")),
  Schema.Boolean,
  {
    to: (s) => s === "true",
    from: (b) => (b ? "true" : "false"),
  },
)
const jsonNumber = Grammar.mapSchema(
  Grammar.lexeme(Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number")),
  Schema.Finite,
  { to: Number, from: String },
)
const jsonString: Grammar.Grammar<string> = Grammar.mapSchema(
  Grammar.lexeme(Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string")),
  Schema.String,
  {
    to: (s) => JSON.parse(s),
    from: (s) => JSON.stringify(s),
  },
)

const jsonValue: Grammar.Grammar<JsonValue> = Grammar.lazy(
  () => Grammar.choice(jsonNull, jsonBool, jsonNumber, jsonString, jsonArray, jsonObject),
  { name: "value" },
)

const jsonArray: Grammar.Grammar<Array<JsonValue>> = Grammar.guard(
  Grammar.between(
    Grammar.label("'['", Grammar.symbol("[")),
    Grammar.label("']'", Grammar.symbol("]")),
    Grammar.sepBy(jsonValue, Grammar.symbol(",")),
  ),
  Array.isArray,
)

const member = Grammar.map(
  Grammar.struct({ key: jsonString, colon: Grammar.symbol(":"), value: jsonValue }),
  {
    to: ({ key, value }) => [key, value] as const,
    from: ([key, value]) => ({ key, colon: ":" as const, value }),
  },
)
const jsonObject: Grammar.Grammar<{ [key: string]: JsonValue }> = Grammar.guard(
  Grammar.map(
    Grammar.between(
      Grammar.label("'{'", Grammar.symbol("{")),
      Grammar.label("'}'", Grammar.symbol("}")),
      Grammar.sepBy(member, Grammar.symbol(",")),
    ),
    {
      to: (entries) => Object.fromEntries(entries),
      from: (obj) => Object.entries(obj),
    },
  ),
  (v) => v !== null && typeof v === "object" && !Array.isArray(v),
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const document = `{ "name": "ada", "age": 36, "tags": ["math", "code"], "address": { "city": "london", "zip": null } }`

Effect.gen(function* () {
  yield* Console.log(`grammar: ${Grammar.render(jsonValue)}\n`)
  const parsed = yield* Grammar.parse(document, jsonValue)
  yield* Console.log(`parse ${document}\n  →  ${json(parsed)}`)
  const printed = yield* Grammar.print(jsonValue, parsed)
  yield* Console.log(`print\n  →  ${printed}`)
}).pipe(Effect.runSync)
