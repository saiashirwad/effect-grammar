import { Console, Effect, Result } from "effect"

import * as Grammar from "../src/index.ts"

const netstring = Grammar.gen(function* () {
  const length = yield* Grammar.integer
  yield* Grammar.literal(":")
  const payload = yield* Grammar.take(length)
  yield* Grammar.literal(",")
  return { length, payload }
})

const show = <A>(r: Result.Result<A, { readonly message: string }>) =>
  Result.match(r, { onSuccess: JSON.stringify, onFailure: (e) => `✗ ${e.message}` })

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(netstring)}\n`)
  for (const source of ["12:hello world!,", "5:hi,"]) {
    yield* Console.log(`parse "${source}"  →  ${show(Grammar.parse(netstring, source))}`)
  }
  yield* Console.log(
    `print { length: 12, payload: "hello world!" }  →  ${show(
      Grammar.print(netstring, { length: 12, payload: "hello world!" }),
    )}`,
  )
}).pipe(Effect.runSync)
