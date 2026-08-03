import { Console, Effect } from "effect";
import { attempt, char, or_, parse, regex } from "../src/parser.ts";

const trueKeyword = Effect.gen(function* () {
  yield* char("t");
  yield* char("r");
  yield* char("u");
  yield* char("e");
  return true;
});

const identifier = regex(/[a-z]+/, "identifier");

const committed = or_(trueKeyword, identifier);
const backtracking = or_(attempt(trueKeyword), identifier);

for (const [label, p] of [
  ["or_", committed],
  ["or_ + attempt", backtracking],
] as const) {
  const r = Effect.runSync(parse("truce", p));
  Effect.runSync(
    Console.log(
      r._tag === "Success"
        ? `${label}  →  parsed: ${JSON.stringify(r.success)}`
        : `${label}  →  expected ${r.failure.expected} at position ${r.failure.pos}, found ${JSON.stringify(r.failure.found)}`,
    ),
  );
}
