import { Console, Effect, Stream } from "effect";
import * as Grammar from "../src/grammar.ts";

const dot = Grammar.literal(".");
const octet = Grammar.map(Grammar.regex(/\d{1,3}/, "octet"), { to: Number, from: String });

const ipLine = Grammar.map(
  Grammar.struct({
    a: octet,
    dot1: dot,
    b: octet,
    dot2: dot,
    c: octet,
    dot3: dot,
    d: octet,
    eol: Grammar.literal("\n"),
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
      eol: "\n" as const,
    }),
  },
);

const chunks = Stream.fromIterable(["192.168", ".1.1\n10.", "0.0.1\n172", ".16.0.1\n"]);

await Effect.runPromise(
  Grammar.streamElements(chunks, ipLine).pipe(
    Stream.runForEach((ip) => Console.log(`emitted: ${ip.join(".")}`)),
  ),
);
