import { Console, Effect, Schema } from "effect"

import * as Grammar from "../src/grammar.ts"

const length = Grammar.map(Grammar.struct({ n: Grammar.integer, colon: Grammar.literal(":") }), {
  to: ({ n }) => n,
  from: (n: number) => ({ n, colon: ":" as const }),
})

const exactly = (n: number): Grammar.Grammar<string> =>
  Grammar.map(Grammar.count(Grammar.regex(/[\s\S]/, "char"), n), {
    to: (chars) => chars.join(""),
    from: (s: string) => s.split(""),
  })

const netstring: Grammar.Grammar<string> = Grammar.map(
  Grammar.struct({
    payload: Grammar.bind(length, { to: exactly, from: (s: string) => s.length }),
    comma: Grammar.literal(","),
  }),
  {
    to: ({ payload }) => payload,
    from: (s: string) => ({ payload: s, comma: "," as const }),
  },
)

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

Effect.runSync(Console.log(`grammar: ${Grammar.render(netstring)}\n`))

const parsed = Effect.runSync(Grammar.parse("12:hello world!,", netstring))
Effect.runSync(Console.log(`parse "12:hello world!,"\n  →  ${json(parsed)}`))

const printed = Effect.runSync(Grammar.print(netstring, "round trip ✓"))
const reparsed = Effect.runSync(Grammar.parse(printed, netstring))
Effect.runSync(
  Console.log(
    `print ${json("round trip ✓")}\n  →  ${printed}\n  →  re-parse  →  ${json(reparsed)}`,
  ),
)

const parseOnly = Grammar.bind(Grammar.integer, { to: exactly })
const r = Effect.runSync(Effect.result(Grammar.print(parseOnly, "abc")))
Effect.runSync(
  Console.log(
    r._tag === "Success"
      ? `print without \`from\`  →  ${r.success}`
      : `print without \`from\`  →  PrintError: ${r.failure.message}`,
  ),
)
