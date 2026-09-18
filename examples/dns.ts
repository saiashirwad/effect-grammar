import { Console, Effect, Schema, SchemaIssue } from "effect"

import * as Binary from "../src/binary.ts"
import * as Grammar from "../src/index.ts"

const header = Grammar.merge(
  Grammar.struct({ id: Binary.uint16 }),
  Binary.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 }),
  Grammar.struct({
    qdcount: Binary.uint16,
    ancount: Binary.uint16,
    nscount: Binary.uint16,
    arcount: Binary.uint16,
  }),
)

const label = Binary.uint8.pipe(
  Grammar.filter((length) => length >= 1 && length <= 63, "label length"),
  Binary.lengthPrefixed,
  Binary.ascii,
)

const question = Grammar.struct({
  qname: Grammar.many(label, { min: 1 }).pipe(Grammar.suffix(Binary.literal(0))),
  qtype: Binary.uint16,
  qclass: Binary.uint16,
})

const query = Grammar.gen(function* () {
  const head = yield* header
  const questions = yield* Grammar.repeat(question, head.qdcount)
  return { header: head, questions }
})

const { Bit, Uint16 } = Binary
const Nibble = Binary.Uint(4)

const DnsHeader = Schema.Struct({
  id: Uint16,
  qr: Bit,
  opcode: Nibble,
  aa: Bit,
  tc: Bit,
  rd: Bit,
  ra: Bit,
  z: Binary.Uint(3),
  rcode: Nibble,
  qdcount: Uint16,
  ancount: Uint16,
  nscount: Uint16,
  arcount: Uint16,
})

const DnsQuery = Schema.Struct({
  header: DnsHeader,
  questions: Schema.Array(
    Schema.Struct({ qname: Schema.Array(Schema.String), qtype: Uint16, qclass: Uint16 }),
  ),
})

export const HeaderFromUint8Array = Binary.codec(header, DnsHeader, { identifier: "DnsHeader" })
export const QueryFromUint8Array = Binary.codec(query, DnsQuery, { identifier: "DnsQuery" })

const formatIssue = SchemaIssue.makeFormatterDefault()

const report =
  (title: string) =>
  <A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) =>
    effect.pipe(
      Effect.match({
        onSuccess: (value) => `${title}  →  ${JSON.stringify(value)}`,
        onFailure: (error) => `${title}  →  ${formatIssue(error.issue)}`,
      }),
      Effect.flatMap(Console.log),
    )

const packet = Uint8Array.from([
  0xbe, 0xef, 0x01, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x65, 0x78, 0x61,
  0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01,
])

Effect.gen(function* () {
  yield* Console.log(`grammar ${Grammar.render(query)}\n`)

  const head = yield* Schema.decodeEffect(HeaderFromUint8Array)(packet.slice(0, 12))
  yield* Console.log(`header  ${JSON.stringify(head)}`)

  const decoded = yield* Schema.decodeEffect(QueryFromUint8Array)(packet)
  yield* Console.log(`query   ${JSON.stringify(decoded.questions)}`)

  const encoded = yield* Schema.encodeEffect(QueryFromUint8Array)(decoded)
  yield* Console.log(`encode  ${Binary.hex(encoded)}\n`)

  yield* Schema.encodeEffect(QueryFromUint8Array)({
    ...decoded,
    header: { ...decoded.header, qdcount: 2 },
  }).pipe(report("qdcount 2, one question"))

  yield* Schema.decodeEffect(HeaderFromUint8Array)(packet.slice(0, 7)).pipe(report("7-byte header"))

  yield* Schema.decodeEffect(QueryFromUint8Array)(packet.with(12, 0x40)).pipe(
    report("label length 64"),
  )
}).pipe(Effect.runSync)
