import type { Schema } from "effect"

import { gen, transform } from "../combinators.ts"
import type { Domain, Grammar, Ref } from "../core.ts"

export const prefixedBy = <B extends { readonly length: number }, D extends Domain, T extends Domain>(
  length: Grammar<number, D>,
  take: (length: Ref<number>) => Grammar<B, T>,
  to: Schema.Schema<B>,
): Grammar<B, D | T> =>
  gen(function*() {
    const size = yield* length
    // SAFETY: B has a length, so it is not void and yielding it binds a Ref<B>.
    const body = (yield* take(size)) as Ref<B>
    return { size, body }
  }).pipe(
    transform({
      to,
      decode: ({ body }) => body,
      encode: (body: B) => ({ size: body.length, body }),
    }),
  )
