import { Effect, Schema } from "effect"

import { locateParseError, ParseError, UpstreamError } from "./error.ts"
import { makeStringState, ParseState } from "./state.ts"

/** Run a parse-only Effect over a whole string. Attaches line/column on `ParseError`. */
export const parse = <A, E>(input: string, p: Effect.Effect<A, E, ParseState>) =>
  Effect.gen(function* () {
    const state = yield* makeStringState(input)
    return yield* p.pipe(
      Effect.provideService(ParseState, state),
      // String input has no upstream; this can never fire.
      Effect.catchIf(Schema.is(UpstreamError), (e) => Effect.die(e)),
      Effect.mapError((e) => (Schema.is(ParseError)(e) ? locateParseError(input, e) : e)),
    )
  }).pipe(Effect.result)
