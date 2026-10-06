import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const person = Grammar.gen(function*() {
  const name = yield* Grammar.regex(/[a-z]+/, "name")
  yield* Grammar.literal(":")
  const age = yield* Grammar.integer
  return { name, age }
})

const Person = GrammarSchema.codec(person).check(
  Schema.makeFilter(({ name, age }: Grammar.Type<typeof person>) => {
    const issues: Array<Schema.FilterIssue> = []
    if (name.length < 3) issues.push({ path: ["name"], issue: "Expected a value with a length of at least 3" })
    if (age < 0 || age > 120) issues.push({ path: ["age"], issue: "Expected a value between 0 and 120" })
    return issues
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
  )).pipe(Effect.runSync)
