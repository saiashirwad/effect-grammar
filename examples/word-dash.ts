import { Console, Effect } from "effect";
import { char, parse, regex } from "../src/parser.ts";

const wordDash = Effect.gen(function* () {
  const word = yield* regex(/[a-z]+/, "word");
  yield* char("-");
  return word;
});

const r = Effect.runSync(parse("abc-def", wordDash));
Effect.runSync(
  Console.log(r._tag === "Success" ? `wordDash  →  ${r.success}` : `wordDash  →  failed`),
);
