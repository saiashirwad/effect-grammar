// https://x.com/dillon_mulroy/status/1930248688716169588

import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"

const header = G.gen(function* () {
  const id = yield* B.uint16
  const flags = yield* B.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 })
  const qdcount = yield* B.uint16
  const ancount = yield* B.uint16
  const nscount = yield* B.uint16
  const arcount = yield* B.uint16
  return { id, ...flags, qdcount, ancount, nscount, arcount }
})

const label = B.uint8.pipe(
  G.filter((length: number) => length >= 1 && length <= 63, "label length"),
  B.lengthPrefixed,
  B.ascii,
)

const question = G.struct({
  qname: label.pipe(G.many(), G.suffix(B.literal(0))),
  qtype: B.uint16,
  qclass: B.uint16,
})

const query = G.gen(function* () {
  const head = yield* header
  const questions = yield* question.pipe(G.repeat(head.qdcount))
  return { header: head, questions }
})

const DnsHeader = Schema.Struct({
  id: B.uintSchema(16),
  qr: B.bitSchema,
  opcode: B.uintSchema(4),
  aa: B.bitSchema,
  tc: B.bitSchema,
  rd: B.bitSchema,
  ra: B.bitSchema,
  z: B.uintSchema(3),
  rcode: B.uintSchema(4),
  qdcount: B.uintSchema(16),
  ancount: B.uintSchema(16),
  nscount: B.uintSchema(16),
  arcount: B.uintSchema(16),
})

const DnsQuery = Schema.Struct({
  header: DnsHeader,
  questions: Schema.Array(
    Schema.Struct({ qname: Schema.Array(Schema.String), qtype: B.uintSchema(16), qclass: B.uintSchema(16) }),
  ),
})

export const HeaderFromUint8Array = B.codec(header, DnsHeader, { identifier: "DnsHeader" })
export const QueryFromUint8Array = B.codec(query, DnsQuery, { identifier: "DnsQuery" })

const formatIssue = SchemaIssue.makeFormatterDefault()

const report =
  (title: string) =>
  <A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) =>
    effect.pipe(
      Effect.flip,
      Effect.flatMap((error) => Console.log(`${title}  →  ${formatIssue(error.issue)}`)),
    )

const headerJson = Schema.encodeEffect(Schema.fromJsonString(DnsHeader))
const questionsJson = Schema.encodeEffect(Schema.fromJsonString(DnsQuery.fields.questions))

const packet = Uint8Array.from([
  0xbe, 0xef, 0x01, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c,
  0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01,
])

Effect.gen(function* () {
  yield* Console.log(`grammar ${G.render(query)}\n`)

  const head = yield* Schema.decodeEffect(HeaderFromUint8Array)(packet.slice(0, 12))
  yield* Console.log(`header  ${yield* headerJson(head)}`)

  const decoded = yield* Schema.decodeEffect(QueryFromUint8Array)(packet)
  yield* Console.log(`query   ${yield* questionsJson(decoded.questions)}`)

  const encoded = yield* Schema.encodeEffect(QueryFromUint8Array)(decoded)
  yield* Console.log(`encode  ${B.hex(encoded)}\n`)

  yield* Schema.encodeEffect(QueryFromUint8Array)({
    ...decoded,
    header: { ...decoded.header, qdcount: 2 },
  }).pipe(report("qdcount 2, one question"))

  yield* Schema.decodeEffect(HeaderFromUint8Array)(packet.slice(0, 7)).pipe(report("7-byte header"))

  yield* Schema.decodeEffect(QueryFromUint8Array)(packet.with(12, 0x40)).pipe(report("label length 64"))
}).pipe(Effect.runSync)
