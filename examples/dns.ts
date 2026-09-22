// https://x.com/dillon_mulroy/status/1930248688716169588

import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"

const header = G.merge(
  G.struct({ id: B.uint16 }),
  B.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 }),
  G.struct({
    qdcount: B.uint16,
    ancount: B.uint16,
    nscount: B.uint16,
    arcount: B.uint16,
  }),
)

const label = B.uint8.pipe(
  G.filter((length) => length >= 1 && length <= 63, "label length"),
  B.lengthPrefixed,
  B.ascii,
)

const question = G.struct({
  qname: G.many(label).pipe(G.suffix(B.literal(0))),
  qtype: B.uint16,
  qclass: B.uint16,
})

const query = G.gen(function* () {
  const head = yield* header
  const questions = yield* G.repeat(question, head.qdcount)
  return { header: head, questions }
})

const DnsHeader = Schema.Struct({
  id: B.Uint16,
  qr: B.Bit,
  opcode: B.Uint(4),
  aa: B.Bit,
  tc: B.Bit,
  rd: B.Bit,
  ra: B.Bit,
  z: B.Uint(3),
  rcode: B.Uint(4),
  qdcount: B.Uint16,
  ancount: B.Uint16,
  nscount: B.Uint16,
  arcount: B.Uint16,
})

const DnsQuery = Schema.Struct({
  header: DnsHeader,
  questions: Schema.Array(Schema.Struct({ qname: Schema.Array(Schema.String), qtype: B.Uint16, qclass: B.Uint16 })),
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
