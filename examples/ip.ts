import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/grammar.ts"

const Octet = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const IpAddress = Schema.Tuple([Octet, Octet, Octet, Octet])

const octet = Grammar.mapSchema(Grammar.regex(/\d{1,3}/, "octet"), Octet, {
  to: Number,
  from: String,
})

const dot = Grammar.literal(".")

const ip = Grammar.mapSchema(
  Grammar.struct({
    a: octet,
    dot1: dot,
    b: octet,
    dot2: dot,
    c: octet,
    dot3: dot,
    d: octet,
  }),
  IpAddress,
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
)

const Ip = Grammar.toSchema(ip, IpAddress, { identifier: "IpAddress" })

const formatIssue = SchemaIssue.makeFormatterDefault()

const samples = ["192.168.1.1", "10.0.300.7", "192.168.1", "not-an-ip"] as const

const check = (source: string) =>
  Schema.decodeUnknownEffect(Ip)(source).pipe(
    Effect.match({
      onSuccess: (value) => `${source}  →  ${value.join(".")}`,
      onFailure: (err) => `${source}  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )

Effect.runFork(Effect.forEach(samples, check, { discard: true }))
