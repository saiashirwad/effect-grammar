import { Effect, Option, Scope, Stream } from "effect"

import { UpstreamError } from "./error.ts"
import { getPos, isEof, makeStreamState, ParseState, release } from "./state.ts"

/**
 * Run a parser once over a stream of chunks, pulling input on demand. The
 * parser sees one continuous input; chunk boundaries are invisible to it.
 * Upstream failures surface as `UpstreamError`.
 */
export const parseStream = <A, E, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  p: Effect.Effect<A, E, ParseState>,
): Effect.Effect<A, E | UpstreamError, Exclude<R2, Scope.Scope>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(input)
      const state = yield* makeStreamState(pull)
      return yield* p.pipe(Effect.provideService(ParseState, state))
    }),
  )

/**
 * Parse a stream of chunks into a stream of values: run `element` repeatedly
 * until end of input, emitting each value as soon as it parses. Consumed
 * input is released between elements, so memory stays bounded by one
 * element (unless an `attempt` inside the element holds more). Each element
 * must consume input — a zero-width element is a defect.
 */
export const streamElements = <A, E, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  element: Effect.Effect<A, E, ParseState>,
): Stream.Stream<A, E | UpstreamError, Exclude<R2, Scope.Scope>> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(input)
      const state = yield* makeStreamState(pull)
      const withState = <X, EX>(eff: Effect.Effect<X, EX, ParseState>) =>
        eff.pipe(Effect.provideService(ParseState, state))
      const step = Effect.gen(function* () {
        if (yield* withState(isEof)) return [[], Option.none()] as const
        const mark = yield* withState(getPos)
        const a = yield* withState(element)
        if ((yield* withState(getPos)) === mark) {
          return yield* Effect.die(
            new Error("streamElements: element parser succeeded without consuming input"),
          )
        }
        yield* withState(release)
        return [[a], Option.some(undefined)] as const
      })
      return Stream.paginate(undefined, () => step)
    }),
  )
