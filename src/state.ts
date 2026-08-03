import { Context, Effect, Option, Pull, Ref } from "effect";
import { ParseError, UpstreamError } from "./error.ts";

/**
 * The cursor a parser runs against. The same shape backs whole-string parsing
 * (`makeStringState`: buffer pre-filled, `done` from the start) and streaming
 * parsing (`makeStreamState`: `fill` pulls chunks from upstream on demand).
 *
 * Positions are absolute and monotonic. `base` is the absolute position of
 * `buffer[0]`; `release` drops consumed input before `pos`, which is only
 * done at points where no backtrack can reach it.
 */
export interface ParseStateShape {
  readonly buffer: Ref.Ref<string>;
  readonly pos: Ref.Ref<number>;
  readonly base: Ref.Ref<number>;
  readonly fill: Effect.Effect<void, UpstreamError>;
  readonly done: Ref.Ref<boolean>;
}

export class ParseState extends Context.Service<ParseState, ParseStateShape>()("ParseState") {}

export const makeStringState = (input: string): Effect.Effect<ParseStateShape> =>
  Effect.gen(function* () {
    return {
      buffer: yield* Ref.make(input),
      pos: yield* Ref.make(0),
      base: yield* Ref.make(0),
      fill: Effect.void,
      done: yield* Ref.make(true),
    };
  });

export const makeStreamState = <E>(
  pull: Pull.Pull<ReadonlyArray<string>, E>,
): Effect.Effect<ParseStateShape> =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make("");
    const done = yield* Ref.make(false);
    const next = pull.pipe(
      Pull.catchDone(() => Effect.succeed(undefined)),
      Effect.mapError((cause) => new UpstreamError({ cause })),
    );
    const fill: Effect.Effect<void, UpstreamError> = Effect.gen(function* () {
      if (yield* Ref.get(done)) return;
      const chunk = yield* next;
      if (chunk === undefined) {
        yield* Ref.set(done, true);
      } else {
        yield* Ref.update(buffer, (b) => b + chunk.join(""));
      }
    });
    return { buffer, pos: yield* Ref.make(0), base: yield* Ref.make(0), fill, done };
  });

export const getPos = Effect.flatMap(ParseState, ({ pos }) => Ref.get(pos));

export const seek = (p: number) =>
  Effect.gen(function* () {
    const { pos, base } = yield* ParseState;
    if (p < (yield* Ref.get(base))) {
      return yield* Effect.die(
        new Error(`cannot rewind to position ${p}: input before it was released`),
      );
    }
    yield* Ref.set(pos, p);
  });

/** The buffered, not-yet-consumed input. */
const remaining = Effect.gen(function* () {
  const { buffer, pos, base } = yield* ParseState;
  return (yield* Ref.get(buffer)).slice((yield* Ref.get(pos)) - (yield* Ref.get(base)));
});

/** The character at the cursor, or `undefined` at end of input. Pulls upstream if needed. */
export const peek: Effect.Effect<string | undefined, UpstreamError, ParseState> = Effect.gen(
  function* () {
    const { fill, done } = yield* ParseState;
    let rest = yield* remaining;
    while (rest.length === 0 && !(yield* Ref.get(done))) {
      yield* fill;
      rest = yield* remaining;
    }
    return rest[0];
  },
);

/** Whether the cursor is at end of input. Pulls upstream until a chunk arrives or it ends. */
export const isEof: Effect.Effect<boolean, UpstreamError, ParseState> = Effect.map(
  peek,
  (c) => c === undefined,
);

/**
 * Whether the input at the cursor starts with `s`. Pulls at most until `s`
 * is decided — bounded by the length of `s`.
 */
export const startsWith = (s: string): Effect.Effect<boolean, UpstreamError, ParseState> =>
  Effect.gen(function* () {
    const { fill, done } = yield* ParseState;
    while (true) {
      const rest = yield* remaining;
      if (rest.length >= s.length) return rest.startsWith(s);
      if (!s.startsWith(rest)) return false;
      if (yield* Ref.get(done)) return false;
      yield* fill;
    }
  });

/**
 * Match `re` at the cursor. Streaming caveat: while upstream is alive, a
 * match that reaches the end of the buffer may extend (maximal munch), and a
 * failed match may succeed after more input — so this pulls until the match
 * stabilizes. At a choice point over a long stream, prefer `literal`/`char`
 * alternatives, which decide within bounded input.
 */
export const matchRegex = (
  re: RegExp,
): Effect.Effect<Option.Option<string>, UpstreamError, ParseState> =>
  Effect.gen(function* () {
    const { fill, done } = yield* ParseState;
    while (true) {
      const rest = yield* remaining;
      // Reset so /g and /y do not carry lastIndex across matches or fills.
      re.lastIndex = 0;
      const m = re.exec(rest);
      const matched = m !== null && m.index === 0;
      const exhausted = yield* Ref.get(done);
      if (matched && (m[0].length < rest.length || exhausted)) return Option.some(m[0]);
      if (exhausted) return Option.none();
      yield* fill;
    }
  });

/**
 * Drop buffered input before the cursor. Only call where no backtrack can
 * reach before `pos` (e.g. between top-level elements of a stream) — `seek`
 * before the released point defects.
 */
export const release: Effect.Effect<void, never, ParseState> = Effect.gen(function* () {
  const { buffer, pos, base } = yield* ParseState;
  const p = yield* Ref.get(pos);
  const b = yield* Ref.get(base);
  if (p > b) {
    yield* Ref.update(buffer, (buf) => buf.slice(p - b));
    yield* Ref.set(base, p);
  }
});

export const failHere = (expected: string) =>
  Effect.gen(function* () {
    const pos = yield* getPos;
    return yield* new ParseError({ pos, expected, found: yield* peek });
  });
