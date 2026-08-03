import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import * as Grammar from "../src/grammar.ts";
import { ParseError } from "../src/error.ts";

/** Run a parse Effect and return the success value, or fail the test. */
export const parseOk = <A>(input: string, grammar: Grammar.Grammar<A>): A => {
  const r = Effect.runSync(Effect.result(Grammar.parse(input, grammar)));
  if (r._tag !== "Success") assert.fail(`expected parse success, got Failure(${String(r.failure)})`);
  return r.success;
};

/** Run a parse Effect and return the ParseError, or fail the test. */
export const parseFail = <A>(input: string, grammar: Grammar.Grammar<A>): ParseError => {
  const r = Effect.runSync(Effect.result(Grammar.parse(input, grammar)));
  if (r._tag !== "Failure") assert.fail(`expected parse failure, got Success(${JSON.stringify(r.success)})`);
  assert.ok(Schema.is(ParseError)(r.failure), `expected ParseError, got ${r.failure}`);
  return r.failure;
};

export const parsePrefixOk = <A>(input: string, grammar: Grammar.Grammar<A>): A => {
  const r = Effect.runSync(Effect.result(Grammar.parsePrefix(input, grammar)));
  if (r._tag !== "Success")
    assert.fail(`expected parsePrefix success, got Failure(${String(r.failure)})`);
  return r.success;
};

export const printOk = <A>(grammar: Grammar.Grammar<A>, value: A): string => {
  const r = Effect.runSync(Effect.result(Grammar.print(grammar, value)));
  if (r._tag !== "Success") assert.fail(`expected print success, got Failure(${String(r.failure)})`);
  return r.success;
};

export const printFail = <A>(grammar: Grammar.Grammar<A>, value: A): Grammar.PrintError => {
  const r = Effect.runSync(Effect.result(Grammar.print(grammar, value)));
  if (r._tag !== "Failure") assert.fail(`expected print failure, got Success(${JSON.stringify(r.success)})`);
  return r.failure;
};

/**
 * Round-trip law: print then re-parse must yield a structurally equal value.
 * Delegates to {@link Grammar.checkRoundTrip}.
 */
export const assertRoundTrip = <A>(grammar: Grammar.Grammar<A>, value: A): void => {
  const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(grammar, value)));
  if (r._tag !== "Success") assert.fail(String(r.failure));
};
