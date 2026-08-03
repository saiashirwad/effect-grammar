import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/grammar.ts"

type JsonValue = null | boolean | number | string | Array<JsonValue> | { [key: string]: JsonValue }

const jsonNull = Grammar.guard(
  Grammar.map(Grammar.symbol("null"), {
    to: (): JsonValue => null,
    from: () => "null" as const,
  }),
  (v) => v === null,
)
const jsonBool = Grammar.guard(
  Grammar.map(Grammar.choice(Grammar.symbol("true"), Grammar.symbol("false")), {
    to: (s): JsonValue => s === "true",
    from: (b) => (b ? "true" : "false"),
  }),
  (v) => typeof v === "boolean",
)
const jsonNumber = Grammar.guard(
  Grammar.map(
    Grammar.lexeme(Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number")),
    { to: (s): JsonValue => Number(s), from: String },
  ),
  (v) => typeof v === "number",
)
const jsonString: Grammar.Grammar<string> = Grammar.guard(
  Grammar.map(Grammar.lexeme(Grammar.regex(/"(?:[^"\\]|\\.)*"/, "string")), {
    to: (s) => JSON.parse(s),
    from: (s) => JSON.stringify(s),
  }),
  (v) => typeof v === "string",
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

Effect.runSync(Console.log(`grammar: ${Grammar.render(jsonValue)}\n`))

const document = `{ "name": "ada", "age": 36, "tags": ["math", "code"], "address": { "city": "london", "zip": null } }`
const parsed = Effect.runSync(Grammar.parse(document, jsonValue))
Effect.runSync(Console.log(`parse ${document}\n  →  ${json(parsed)}`))

const printed = Effect.runSync(Grammar.print(jsonValue, parsed))
const reparsed = Effect.runSync(Grammar.parse(printed, jsonValue))
Effect.runSync(Console.log(`print\n  →  ${printed}\nre-parse\n  →  ${json(reparsed)}`))

const Json = Grammar.toSchema(jsonValue, Schema.Unknown, { identifier: "Json" })
const encoded = Effect.runSync(Schema.encodeEffect(Json)(parsed))
Effect.runSync(
  Console.log(
    `schema encode\n  →  ${encoded}\n  →  decode  →  ${json(Effect.runSync(Schema.decodeUnknownEffect(Json)(encoded)))}`,
  ),
)

const depth = 1000
const deep = "[".repeat(depth) + "1" + "]".repeat(depth)
const deepParsed = Effect.runSync(Grammar.parse(deep, jsonValue))
Effect.runSync(
  Console.log(
    `depth ${depth}: parsed, printed ${Effect.runSync(Grammar.print(jsonValue, deepParsed)).length} chars`,
  ),
)
