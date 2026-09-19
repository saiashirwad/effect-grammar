import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaIssue } from "effect"

import * as Binary from "../src/binary.ts"
import * as G from "../src/index.ts"

const parseOk = <A>(grammar: G.Grammar<A>, ...input: ReadonlyArray<number>): A =>
  Result.getOrThrow(Binary.parse(grammar, Uint8Array.from(input)))

const parseFail = <A>(
  grammar: G.Grammar<A>,
  ...input: ReadonlyArray<number>
): Binary.ParseError => {
  const result = Binary.parse(grammar, Uint8Array.from(input))
  if (Result.isSuccess(result)) assert.fail("expected parse failure")
  return result.failure
}

const printOk = <A>(grammar: G.Grammar<A>, value: A): ReadonlyArray<number> =>
  Array.from(Result.getOrThrow(Binary.printChecked(grammar, value)))

const printFail = <A>(grammar: G.Grammar<A>, value: A): G.PrintError => {
  const result = Binary.print(grammar, value)
  if (Result.isSuccess(result)) assert.fail("expected print failure")
  return result.failure
}

describe("unsigned integers", () => {
  it.effect("reads and writes both byte orders and rejects values outside the width", () =>
    Effect.sync(() => {
      assert.equal(parseOk(Binary.uint8, 0xfe), 0xfe)
      assert.equal(parseOk(Binary.uint16, 0x12, 0x34), 0x1234)
      assert.equal(parseOk(Binary.uint16le, 0x34, 0x12), 0x1234)
      assert.deepEqual(printOk(Binary.uint32, 0xffeeddcc), [0xff, 0xee, 0xdd, 0xcc])
      assert.deepEqual(printOk(Binary.uint32le, 0xffeeddcc), [0xcc, 0xdd, 0xee, 0xff])
      assert.match(printFail(Binary.uint8, 256).message, /expected uint8/)
      assert.match(printFail(Binary.uint16, 1.5).message, /expected uint16/)
    }),
  )
})

describe("Uint", () => {
  it.effect("accepts exactly the values that fit and rejects widths a number cannot hold", () =>
    Effect.sync(() => {
      assert.ok(Schema.is(Binary.Uint(1))(1))
      assert.ok(!Schema.is(Binary.Uint(1))(2))
      assert.ok(Schema.is(Binary.Uint(53))(Number.MAX_SAFE_INTEGER))
      assert.ok(!Schema.is(Binary.Uint(53))(2 ** 53))
      for (const size of [0, 1.5, 54]) assert.throws(() => Binary.Uint(size), /1 to 53 bits/)
    }),
  )
})

describe("bits", () => {
  const flags = Binary.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 })

  it.effect("splits bytes into fields, first field highest, including fields past 32 bits", () =>
    Effect.sync(() => {
      const value = parseOk(flags, 0x85, 0x23)
      assert.deepEqual(value, { qr: 1, opcode: 0, aa: 1, tc: 0, rd: 1, ra: 0, z: 2, rcode: 3 })
      assert.deepEqual(printOk(flags, value), [0x85, 0x23])
      const wide = Binary.bits({ tag: 3, value: 53 })
      const large = { tag: 5, value: Number.MAX_SAFE_INTEGER }
      assert.deepEqual(parseOk(wide, ...printOk(wide, large)), large)
    }),
  )

  it.effect("rejects values that do not fit the layout when printing unchecked", () =>
    Effect.sync(() => {
      const byte = Binary.bits({ a: 8 })
      // SAFETY: deliberately adding a field to show the printer rejects it.
      const extra = { a: 1, extra: true } as G.Type<typeof byte>
      assert.match(printFail(byte, extra).message, /unexpected field extra/)
      assert.match(printFail(byte, { a: 256 }).message, /a must be an integer from 0 to 255/)
    }),
  )

  it.effect("reports truncated input at the end of input", () =>
    Effect.sync(() => {
      assert.equal(
        parseFail(flags, 0x85).message,
        "byte 1: expected qr:1 opcode:4 aa:1 tc:1 rd:1 ra:1 z:3 rcode:4: 2 bytes but only 1 remain, found end of input",
      )
    }),
  )

  it.effect("rejects layouts that are not whole bytes or that JavaScript would reorder", () =>
    Effect.sync(() => {
      assert.throws(() => Binary.bits({ a: 3 }), /got a:3/)
      assert.throws(() => Binary.bits({ a: 54, b: 2 }), /got a:54 b:2/)
      assert.throws(() => Binary.bits({ 0: 8 }), /got 0:8/)
    }),
  )
})

describe("bytes / lengthPrefixed / literal", () => {
  it.effect("reads a bound run of bytes after a magic number", () =>
    Effect.sync(() => {
      const frame = G.gen(function* () {
        yield* Binary.literal(0x89, 0x50)
        const size = yield* Binary.uint8
        const body = yield* Binary.bytes(size)
        return { size, body }
      })
      assert.equal(G.render(frame), "0x89 0x50 size:<uint8> body:<byte>{size}")
      assert.deepEqual(parseOk(frame, 0x89, 0x50, 2, 7, 8), { size: 2, body: Uint8Array.of(7, 8) })
      assert.deepEqual(
        printOk(frame, { size: 2, body: Uint8Array.of(7, 8) }),
        [0x89, 0x50, 2, 7, 8],
      )
      assert.equal(parseFail(frame, 0x89, 0x51).message, "byte 1: expected 0x89 0x50, found 0x51")
      assert.match(printFail(frame, { size: 3, body: Uint8Array.of(7, 8) }).message, /3 bytes/)
    }),
  )

  it.effect("derives a byte length prefix and converts text", () =>
    Effect.sync(() => {
      const ascii = Binary.lengthPrefixed(Binary.uint8).pipe(Binary.ascii)
      const utf8 = Binary.lengthPrefixed(Binary.uint8).pipe(Binary.utf8)
      assert.equal(parseOk(ascii, 3, 0x63, 0x6f, 0x6d), "com")
      assert.deepEqual(parseFail(ascii, 1, 0x80).expected, ["ascii"])
      assert.match(printFail(ascii, "é").message, /expected ascii/)
      assert.deepEqual(printOk(utf8, "€"), [3, 0xe2, 0x82, 0xac])
      assert.equal(parseOk(utf8, 3, 0xef, 0xbb, 0xbf), "\ufeff")
      assert.deepEqual(parseFail(utf8, 1, 0xff).expected, ["valid UTF-8"])
      assert.match(printFail(utf8, "\ud800").message, /lone surrogates/)
      assert.deepEqual(G.auditFidelity(utf8), [{ name: "utf8", fidelity: "partial" }])
    }),
  )

  it.effect("rejects characters that are not bytes on input and output", () =>
    Effect.sync(() => {
      const error = G.parse(Binary.uint16, "a\u0100")
      assert.ok(Result.isFailure(error))
      assert.deepEqual(error.failure.expected, ["a byte"])
      assert.equal(error.failure.pos, 1)
      assert.match(printFail(G.regex(/./, "char"), "€").message, /only bytes to be printed/)
      assert.throws(() => Binary.literal(256), /expected bytes, got 256/)
    }),
  )
})

describe("codec", () => {
  const Frame = Schema.Struct({
    version: Binary.Bit,
    kind: Binary.Uint(7),
    names: Schema.Array(Schema.String),
  })
  const frame = G.merge(
    Binary.bits({ version: 1, kind: 7 }),
    G.struct({
      names: Binary.lengthPrefixed(Binary.uint8).pipe(Binary.utf8, G.countPrefixed(Binary.uint8)),
    }),
  )
  const FrameFromBytes = Binary.codec(frame, Frame, { identifier: "Frame" })
  const wire = Uint8Array.of(0x85, 2, 1, 0x61, 2, 0x62, 0x63)

  it.effect("decodes and encodes a Uint8Array", () =>
    Effect.gen(function* () {
      const value = yield* Schema.decodeEffect(FrameFromBytes)(wire)
      assert.deepEqual(value, { version: 1, kind: 5, names: ["a", "bc"] })
      const encoded = yield* Schema.encodeEffect(FrameFromBytes)(value)
      assert.equal(Binary.hex(encoded), "85 02 01 61 02 62 63")
    }),
  )

  it.effect("reports decode failures by byte offset", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Schema.decodeEffect(FrameFromBytes)(wire.slice(0, 6)))
      assert.match(
        SchemaIssue.makeFormatterDefault()(error.issue),
        /byte 6: expected 2 bytes but only 1 remain, found end of input/,
      )
    }),
  )
})
