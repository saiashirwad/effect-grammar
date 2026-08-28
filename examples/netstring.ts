/**
 * Netstrings (`<length>:<payload>,`): a dependent parse. The length just
 * parsed decides how many characters to read next — plain control flow inside
 * `gen`. The value drops the length, so a `transform` supplies the inverse.
 */
import { Console, Effect, Result } from "effect"

import { Grammar } from "../src/index.ts"

const netstring = Grammar.gen(function* () {
  const n = yield* Grammar.field("n", Grammar.integer)
  yield* Grammar.literal(":")
  const payload = yield* Grammar.field(
    "payload",
    Grammar.many(Grammar.regex(/[\s\S]/, "char"), { min: n, max: n }),
  )
  yield* Grammar.literal(",")
  return { n, payload }
}).pipe(
  Grammar.transform({
    decode: ({ payload }) => payload.join(""),
    encode: (s) => ({ n: s.length, payload: s.split("") }),
  }),
)

const show = (r: Result.Result<unknown, { readonly message: string }>) =>
  Result.isSuccess(r) ? JSON.stringify(r.success) : `✗ ${r.failure.message}`

Effect.runSync(
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
    yield* Console.log(
      `roundTrip "a,b:c"        →  ${show(Grammar.checkRoundTrip(netstring, "a,b:c"))}`,
    )
  }),
)
