import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"
import { jsonValue } from "./grammars/json.ts"

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
      onFailure: (error) => `decode "[1, 2,"  →  ${formatIssue(error.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )
}).pipe(Effect.runSync)
