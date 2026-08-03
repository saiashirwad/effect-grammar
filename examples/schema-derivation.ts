import { Console, Effect, Schema } from "effect";
import * as Grammar from "../src/grammar.ts";

const dot = Grammar.literal(".");

const octet = Grammar.map(Grammar.regex(/\d{1,3}/, "octet"), {
  to: Number,
  from: String,
});

const ip = Grammar.map(
  Grammar.struct({
    a: octet,
    dot1: dot,
    b: octet,
    dot2: dot,
    c: octet,
    dot3: dot,
    d: octet,
  }),
  {
    to: ({ a, b, c, d }) => [a, b, c, d] as const,
    from: ([a, b, c, d]) => ({
      a,
      b,
      c,
      d,
      dot1: "." as const,
      dot2: "." as const,
      dot3: "." as const,
    }),
  },
);

const Octet = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 255 }));
const IpAddress = Grammar.toSchema(ip, Schema.Tuple([Octet, Octet, Octet, Octet]), {
  identifier: "IpAddress",
});

const decode = Schema.decodeUnknownEffect(IpAddress);
const encode = Schema.encodeEffect(IpAddress);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

Effect.runSync(Console.log(`grammar: ${Grammar.render(ip)}\n`));

for (const source of ["192.168.1.1", "10.0.300.7", "192.168.1", "not-an-ip"]) {
  const r = Effect.runSync(Effect.result(decode(source)));
  Effect.runSync(
    Console.log(
      r._tag === "Success"
        ? `decode ${source}  →  ${json(r.success)}`
        : `decode ${source}  →  ${String(r.failure)}`,
    ),
  );
}

const value = [10, 0, 0, 1] as const;
const encoded = Effect.runSync(encode(value));
const roundTripped = Effect.runSync(decode(encoded));
Effect.runSync(
  Console.log(`\nencode ${json(value)}  →  ${json(encoded)}  →  decode  →  ${json(roundTripped)}`),
);

const effectOnly = Grammar.fromEffect(Effect.succeed("hardcoded"), "an opaque effectful parser");
Effect.runSync(
  Console.log(`\nescape hatch parse: ${json(Effect.runSync(Grammar.parsePrefix("anything", effectOnly)))}`),
);
const effectPrint = Effect.runSync(Effect.result(Grammar.print(effectOnly, "hardcoded")));
Effect.runSync(
  Console.log(
    effectPrint._tag === "Success"
      ? `escape hatch print: ${effectPrint.success}`
      : `escape hatch print: PrintError: ${effectPrint.failure.message}`,
  ),
);
