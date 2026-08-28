import { Console, Effect, Result } from "effect"

import * as Grammar from "../src/index.ts"

const char = Grammar.regex(/[\s\S]/, "char")

const netstring = Grammar.gen(function* () {
  const n = yield* Grammar.field("n", Grammar.integer)
  yield* Grammar.literal(":")
  const payload = yield* Grammar.field("payload", Grammar.many(char, { min: n, max: n }))
  yield* Grammar.literal(",")
  return { n, payload }
}).pipe(
  Grammar.transform({
    decode: ({ payload }) => payload.join(""),
    encode: (s) => ({ n: s.length, payload: s.split("") }),
  }),
)

const show = (r: Result.Result<string, { readonly message: string }>) =>
  Result.match(r, { onSuccess: JSON.stringify, onFailure: (e) => `✗ ${e.message}` })

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(netstring)}\n`)
  yield* Console.log(
    `parse "12:hello world!,"  →  ${show(Grammar.parse(netstring, "12:hello world!,"))}`,
  )
  yield* Console.log(
    `parse "5:hello world!,"   →  ${show(Grammar.parse(netstring, "5:hello world!,"))}`,
  )
  yield* Console.log(
    `print "round trip ✓"     →  ${show(Grammar.print(netstring, "round trip ✓"))}`,
  )
}).pipe(Effect.runSync)
