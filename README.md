# effect-grammar

Effect Schema, but for text formats. One definition yields a parser, a printer,
a rendered grammar, and a `Schema<A, string>`.

## Install

```bash
pnpm add effect-grammar effect
```

Depends on Effect v4.
## Grammar

Round-trip parse and print; `Grammar.toSchema` gives a Schema for free.

```ts
import { Schema } from "effect";
import { Grammar } from "effect-grammar";

const port = Grammar.map(Grammar.label("port", Grammar.regex(/\d+/, "digits")), {
  to: Number,
  from: String,
});

const dsn = Grammar.struct({
  scheme: Grammar.literal("postgres://"),
  user: Grammar.label("user", Grammar.regex(/[^:@/?#]+/, "user")),
  at: Grammar.literal("@"),
  host: Grammar.label("host", Grammar.regex(/[^:/?#]+/, "host")),
  portPart: Grammar.optional(Grammar.struct({ sep: Grammar.literal(":"), port })),
});

Grammar.parse("postgres://alice@db.internal:5432", dsn);
// Effect<{ scheme, user, at, host, portPart: { sep, port: 5432 } }>

const Port = Grammar.toSchema(
  port,
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  { identifier: "Port" },
);
Schema.decodeUnknownSync(Port)("5432"); // 5432
Schema.encodeSync(Port)(5432); // "5432"
```

## Parse-only with `Effect.gen`

Write plain Effect programs over the input. Custom errors are yielded failures.

```ts
import { Effect, Schema } from "effect";
import { char, digit, endOfInput, many, parse } from "effect-grammar/parser";

class OutOfRange extends Schema.TaggedErrorClass<OutOfRange>()("OutOfRange", {
  n: Schema.Finite,
}) {}

const byte = Effect.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 });
  const n = Number(digits.join(""));
  if (n > 255) return yield* new OutOfRange({ n });
  return n;
});

const ip = Effect.gen(function* () {
  const a = yield* byte;
  yield* char(".");
  const b = yield* byte;
  yield* char(".");
  const c = yield* byte;
  yield* char(".");
  const d = yield* byte;
  yield* endOfInput;
  return [a, b, c, d] as const;
});

Effect.runSync(parse("192.168.1.1", ip));
// { _tag: "Success", value: [192, 168, 1, 1] }
```
