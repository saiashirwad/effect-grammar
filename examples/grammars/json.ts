import { Predicate, Result, Schema } from "effect"

import * as Grammar from "../../src/index.ts"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

const jsonNull = Grammar.symbol("null").pipe(Grammar.as(null))

const jsonBool = Grammar.choice(
  Grammar.symbol("true").pipe(Grammar.as(true)),
  Grammar.symbol("false").pipe(Grammar.as(false)),
)

const jsonNumber = Grammar.lexeme(Grammar.regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number")).pipe(
  Grammar.decodeTo(Schema.Finite)({ decode: Number, encode: String }),
)

export const jsonString = Grammar.lexeme(
  // eslint-disable-next-line no-control-regex -- JSON strings must reject C0 controls.
  Grammar.regex(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/, "string"),
).pipe(
  Grammar.transformOrFail({
    decode: (text): Result.Result<string, string> => {
      try {
        const value: unknown = JSON.parse(text)
        return Predicate.isString(value) ? Result.succeed(value) : Result.fail("a JSON string")
      } catch (error) {
        return Result.fail(error instanceof Error ? error.message : String(error))
      }
    },
    encode: (value) => Result.succeed(JSON.stringify(value)),
  }),
)

export const jsonValue: Grammar.Grammar<JsonValue> = Grammar.suspend(
  () => Grammar.choice(jsonNull, jsonBool, jsonNumber, jsonString, jsonArray, jsonObject),
  "value",
)

const jsonArray = jsonValue.pipe(
  Grammar.sepBy(Grammar.symbol(",")),
  Grammar.between(Grammar.symbol("["), Grammar.symbol("]")),
)

const member = Grammar.gen(function* () {
  const key = yield* jsonString
  yield* Grammar.symbol(":")
  const value = yield* jsonValue
  return { key, value }
})

const jsonObject = member.pipe(
  Grammar.sepBy(Grammar.symbol(",")),
  Grammar.between(Grammar.symbol("{"), Grammar.symbol("}")),
  Grammar.transform({
    decode: (members): { readonly [key: string]: JsonValue } =>
      Object.fromEntries(members.map(({ key, value }) => [key, value])),
    encode: (object) => Object.entries(object).map(([key, value]) => ({ key, value })),
  }),
  Grammar.filter(Schema.is(Schema.Record(Schema.String, Schema.Unknown)), "object"),
)
