import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

const person = Grammar.gen(function* () {
  const name = yield* Grammar.regex(/[a-z]+/, "name")
  yield* Grammar.literal(":")
  const age = yield* Grammar.integer
  return { name, age }
})

const Person = Grammar.toSchema(
  person,
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(3)),
    age: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
  }),
)

const formatIssue = SchemaIssue.makeFormatterDefault()

const samples = ["ab:200", "alice:x"]

Effect.forEach(samples, (source) =>
  Schema.decodeEffect(Person, { errors: "all" })(source).pipe(
    Effect.match({
      onSuccess: (v) => `${source}  →  ${JSON.stringify(v)}`,
      onFailure: (err) => `${source}  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  ),
).pipe(Effect.runSync)
