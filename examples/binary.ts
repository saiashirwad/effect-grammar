import { Console, Effect, Result, Schema } from "effect"
import * as FastCheck from "effect/testing/FastCheck"

import * as Binary from "../src/binary.ts"
import * as Grammar from "../src/index.ts"
import { lawsFor } from "../src/testing.ts"

// A message: magic, a packed flags byte, a varint byte length, then that many
// bytes of UTF-8. The length is derived from the text, so values do not carry it.
const encoder = new TextEncoder()
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const message = Grammar.gen(function* () {
  yield* Binary.literal([0xca, 0xfe])
  const header = yield* Binary.bitfield(Binary.byte, { version: 4, priority: 4 })
  const length = yield* Binary.varuint
  const text = yield* Binary.utf8(length)
  yield* Grammar.derive(
    length,
    Grammar.mapRef(text, (value) => encoder.encode(value).length, "utf8Length"),
  )
  return { header, text }
})

const compiled = Binary.compile(message)
const input = new Uint8Array([0xca, 0xfe, 0x21, 0x03, 0xe2, 0x82, 0xac])

const Message = Binary.codec(
  message,
  Schema.Struct({
    header: Schema.Struct({ version: Schema.Finite, priority: Schema.Finite }),
    text: Schema.NonEmptyString,
  }),
  { identifier: "Message" },
)

const laws = lawsFor(Binary.format)
const arbitraryMessage = FastCheck.record({
  header: FastCheck.record({ version: FastCheck.constant(2), priority: FastCheck.nat(15) }),
  text: FastCheck.string({ minLength: 1, maxLength: 64 }),
})

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")

const main = Effect.gen(function* () {
  const value = yield* Effect.fromResult(compiled.parse(input))
  const printed = yield* Effect.fromResult(compiled.printChecked(value))
  yield* Console.log(`grammar ${compiled.render}`)
  yield* Console.log(`parse ${hex(input)}\n  →  ${json(value)}`)
  yield* Console.log(`print ${json(value)}\n  →  ${hex(printed)}`)

  const truncated = compiled.parse(input.subarray(0, 5))
  if (Result.isFailure(truncated)) yield* Console.log(`truncated → ${truncated.failure.message}`)
  const wrongLength = compiled.parse(new Uint8Array([0xca, 0xfe, 0x21, 0x02, 0x68, 0x69, 0x21]))
  if (Result.isFailure(wrongLength))
    yield* Console.log(`bad length → ${wrongLength.failure.message}`)

  const decoded = yield* Schema.decodeEffect(Message)(input)
  const encoded = yield* Schema.encodeEffect(Message)(decoded)
  yield* Console.log(`codec decode → ${json(decoded)}`)
  yield* Console.log(`codec encode → ${hex(encoded)}`)

  laws.assertPrintParse(message, value)
  laws.checkPrintParse(message, arbitraryMessage)
  yield* Console.log("laws hold: parse(print(value)) = value over generated messages")
})

if (process.argv[1] === new URL(import.meta.url).pathname) Effect.runSync(main)
