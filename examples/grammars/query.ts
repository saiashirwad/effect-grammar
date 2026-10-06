import * as Grammar from "../../src/index.ts"

const param = Grammar.gen(function*() {
  const key = yield* Grammar.regex(/[a-z]+/, "key")
  yield* Grammar.literal("=")
  const value = yield* Grammar.regex(/[^&]+/, "value")
  return { key, value }
})

export const query = param.pipe(Grammar.sepBy("&"), Grammar.prefix("?"))
