/** The grammar owns shape; the target Schema owns refinements. Both report through SchemaIssue. */
import { Console, Effect, Schema, SchemaIssue } from "effect"

import { Grammar } from "../src/index.ts"

const person = Grammar.seq(
  Grammar.field("name", Grammar.regex(/[a-z]+/, "name")),
  Grammar.literal(":"),
  Grammar.field("age", Grammar.integer),
)

const Person = Grammar.toSchema(
  person,
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(3)),
    age: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
  }),
)

const formatIssue = SchemaIssue.makeFormatterDefault()

Effect.runSync(
  Effect.forEach(["ab:200", "alice:x"], (source) =>
    Schema.decodeUnknownEffect(Person, { errors: "all" })(source).pipe(
      Effect.match({
        onSuccess: (v) => `${source}  →  ${JSON.stringify(v)}`,
        onFailure: (err) => `${source}  →  ${formatIssue(err.issue)}`,
      }),
      Effect.flatMap(Console.log),
    ),
  ),
)
