import { Effect, Option, Schema } from "effect";
import { ParseError } from "./error.ts";
import { failHere, getPos, matchRegex, peek, seek } from "./state.ts";

export const satisfy = (pred: (c: string) => boolean, expected: string) =>
  Effect.gen(function* () {
    const c = yield* peek;
    if (c === undefined || !pred(c)) return yield* failHere(expected);
    yield* seek((yield* getPos) + 1);
    return c;
  });

export const char = (c: string) => satisfy((x) => x === c, JSON.stringify(c));

export const digit = satisfy((c) => c >= "0" && c <= "9", "digit");

export const regex = (re: RegExp, expected: string) => {
  // Drop g/y so sticky/global lastIndex cannot break sequential matches.
  const normalized = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
  return Effect.gen(function* () {
    const pos = yield* getPos;
    const m = yield* matchRegex(normalized);
    if (Option.isNone(m)) return yield* failHere(expected);
    yield* seek(pos + m.value.length);
    return m.value;
  });
};

export const endOfInput = Effect.gen(function* () {
  const c = yield* peek;
  if (c !== undefined) return yield* failHere("end of input");
});

/**
 * Ordered choice. Commits to `p` once it has consumed input — if `p` fails
 * after consuming, `q` is not tried. Wrap `p` in {@link attempt} to opt back
 * into backtracking.
 */
export const or_ = <A, E, R, B, E2, R2>(p: Effect.Effect<A, E, R>, q: Effect.Effect<B, E2, R2>) =>
  Effect.gen(function* () {
    const mark = yield* getPos;
    const r1 = yield* Effect.result(p);
    if (r1._tag === "Success") return r1.success;
    const e1 = r1.failure;
    if (!Schema.is(ParseError)(e1)) return yield* Effect.fail(e1);
    if ((yield* getPos) > mark) return yield* e1;
    yield* seek(mark);
    const r2 = yield* Effect.result(q);
    if (r2._tag === "Success") return r2.success;
    const e2 = r2.failure;
    if (!Schema.is(ParseError)(e2)) return yield* Effect.fail(e2);
    return yield* e2.pos >= e1.pos ? e2 : e1;
  });

/**
 * Rewind on failure: run `p`, and if it fails, restore the input position so
 * an enclosing {@link or_} will try its next option. Errors keep their
 * original position for messages.
 */
export const attempt = <A, E, R>(p: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mark = yield* getPos;
    const r = yield* Effect.result(p);
    if (r._tag === "Success") return r.success;
    if (Schema.is(ParseError)(r.failure)) yield* seek(mark);
    return yield* Effect.fail(r.failure);
  });

/**
 * Run `p` zero or more times (`atLeast` sets a minimum). If `p` fails after
 * consuming input, `many` fails too — wrap `p` in {@link attempt} to keep
 * collecting instead.
 */
export const many = <A, E, R>(p: Effect.Effect<A, E, R>, opts?: { atLeast?: number }) =>
  Effect.gen(function* () {
    const out: Array<A> = [];
    const atLeast = opts?.atLeast ?? 0;
    for (let i = 0; i < atLeast; i++) out.push(yield* p);
    while (true) {
      const mark = yield* getPos;
      const r = yield* Effect.result(p);
      if (r._tag === "Failure") {
        if (!Schema.is(ParseError)(r.failure)) return yield* Effect.fail(r.failure);
        if ((yield* getPos) > mark) return yield* r.failure;
        yield* seek(mark);
        return out;
      }
      if ((yield* getPos) === mark) {
        return yield* Effect.die(new Error("many: parser succeeded without consuming input"));
      }
      out.push(r.success);
    }
  });
