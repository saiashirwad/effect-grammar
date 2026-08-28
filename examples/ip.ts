import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Grammar from "../src/index.ts"

const Octet = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const IpAddress = Schema.Tuple([Octet, Octet, Octet, Octet])

const octet = Grammar.regex(/\d{1,3}/, "octet").pipe(
  Grammar.decodeTo(Octet)({ decode: Number, encode: String }),
)

const ip = Grammar.gen(function* () {
  const a = yield* Grammar.field("a", octet)
  yield* Grammar.literal(".")
  const b = yield* Grammar.field("b", octet)
  yield* Grammar.literal(".")
  const c = yield* Grammar.field("c", octet)
  yield* Grammar.literal(".")
  const d = yield* Grammar.field("d", octet)
  return { a, b, c, d }
}).pipe(
  Grammar.decodeTo(IpAddress)({
    decode: ({ a, b, c, d }) => [a, b, c, d] as const,
    encode: ([a, b, c, d]) => ({ a, b, c, d }),
  }),
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

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(ip)}\n`)
  yield* Effect.forEach(samples, check, { discard: true })
  const encoded = yield* Schema.encodeEffect(Ip)([10, 0, 0, 1])
  yield* Console.log(`\nencode [10,0,0,1]  →  ${encoded}`)
}).pipe(Effect.runSync)
