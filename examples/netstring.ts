import { Console, Effect, Result, Schema } from "effect"

import * as Grammar from "../src/index.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const netstring = Grammar.gen(function* () {
  const length = yield* Grammar.integer
  yield* Grammar.literal(":")
  const payload = yield* Grammar.take(length)
  yield* Grammar.literal(",")
  return payload
})

const show = (r: Result.Result<string, { readonly message: string }>) =>
  Result.match(r, { onSuccess: json, onFailure: (e) => `✗ ${e.message}` })

const samples = ["12:hello world!,", "5:hello world!,"]

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(netstring)}\n`)
  for (const source of samples) {
    yield* Console.log(`parse ${json(source)}  →  ${show(Grammar.parse(netstring, source))}`)
  }
  yield* Console.log(`print "round trip ✓"  →  ${show(Grammar.print(netstring, "round trip ✓"))}`)
}).pipe(Effect.runSync)
