import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

const Octet = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const IpAddress = Schema.Tuple([Octet, Octet, Octet, Octet])

const ip = Grammar.sepBy(
  Grammar.regex(/\d{1,3}/, "octet").pipe(Grammar.transform({ decode: Number, encode: String })),
  ".",
  { min: 4, max: 4 },
).pipe(
  Grammar.transform({
    decode: ([a, b, c, d]) => [a!, b!, c!, d!] as const,
    encode: (tuple) => [...tuple],
  }),
)

const Ip = Grammar.toSchema(ip, IpAddress, { identifier: "IpAddress" })

const decode = Schema.decodeEffect(Ip)
const encode = Schema.encodeEffect(Ip)
const formatIssue = SchemaIssue.makeFormatterDefault()

const samples = ["192.168.1.1", "10.0.300.7", "192.168.1", "not-an-ip"]

const check = (source: string) =>
  decode(source).pipe(
    Effect.match({
      onSuccess: (value) => `${source}  →  ${value.join(".")}`,
      onFailure: (err) => `${source}  →  ${formatIssue(err.issue)}`,
    }),
    Effect.flatMap(Console.log),
  )

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(ip)}\n`)
  yield* Effect.forEach(samples, check, { discard: true })
  const encoded = yield* encode([10, 0, 0, 1])
  yield* Console.log(`\nencode [10,0,0,1]  →  ${encoded}`)
}).pipe(Effect.runSync)
