import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

const age = Grammar.map(Grammar.label("age", Grammar.regex(/\d+/, "digits")), {
  to: Number,
  from: String,
})

const Person = Grammar.toSchema(
  Grammar.map(
    Grammar.struct({
      name: Grammar.label("name", Grammar.regex(/[a-z]+/, "name")),
      sep: Grammar.literal(":"),
      age,
    }),
    {
      to: ({ name, age }) => ({ name, age }),
      from: ({ name, age }) => ({ name, sep: ":" as const, age }),
    },
  ),
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(3)),
    age: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
  }),
)

Effect.runSync(
  Schema.decodeUnknownEffect(Person, { errors: "all" })("ab:200").pipe(
    Effect.catch((err) => Console.error(SchemaIssue.makeFormatterDefault()(err.issue))),
  ),
)
