import { gen, transform } from "../combinators.ts"
import type { Domain, Grammar, Ref } from "../core.ts"

export const prefixedBy = <D extends Domain, T extends Domain>(
  length: Grammar<number, D>,
  take: (length: Ref<number>) => Grammar<string, T>,
): Grammar<string, D | T> =>
  gen(function*() {
    const size = yield* length
    const body = yield* take(size)
    return { size, body }
  }).pipe(
    transform({
      decode: ({ body }) => body,
      encode: (body: string) => ({ size: body.length, body }),
    }),
  )
