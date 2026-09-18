import assert from "node:assert/strict"

import { Effect, Result, Schema, SchemaIssue } from "effect"
import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"

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
  it("reads and writes network byte order", () => {
    assert.equal(parseOk(Binary.uint8, 0xfe), 0xfe)
    assert.equal(parseOk(Binary.uint16, 0x12, 0x34), 0x1234)
    assert.equal(parseOk(Binary.uint32, 0xff, 0xee, 0xdd, 0xcc), 0xffeeddcc)
    assert.deepEqual(printOk(Binary.uint32, 0xffeeddcc), [0xff, 0xee, 0xdd, 0xcc])
  })

  it("reads and writes little-endian", () => {
    assert.equal(parseOk(Binary.uint16le, 0x34, 0x12), 0x1234)
    assert.deepEqual(printOk(Binary.uint32le, 0xffeeddcc), [0xcc, 0xdd, 0xee, 0xff])
  })

  it("rejects values outside the width", () => {
    assert.match(printFail(Binary.uint8, 256).message, /expected uint8/)
    assert.match(printFail(Binary.uint16, -1).message, /expected uint16/)
    assert.match(printFail(Binary.uint16, 1.5).message, /expected uint16/)
  })

  it("round-trips every uint32", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 0, max: 0xffffffff }), (value) => {
        assert.equal(parseOk(Binary.uint32, ...printOk(Binary.uint32, value)), value)
        assert.equal(parseOk(Binary.uint32le, ...printOk(Binary.uint32le, value)), value)
      }),
    )
  })
})

describe("bits", () => {
  const flags = Binary.bits({ qr: 1, opcode: 4, aa: 1, tc: 1, rd: 1, ra: 1, z: 3, rcode: 4 })

  it("splits bytes into fields, first field highest", () => {
    const value = parseOk(flags, 0x85, 0x23)
    assert.deepEqual(value, { qr: 1, opcode: 0, aa: 1, tc: 0, rd: 1, ra: 0, z: 2, rcode: 3 })
    assert.deepEqual(Object.keys(value), ["qr", "opcode", "aa", "tc", "rd", "ra", "z", "rcode"])
    assert.deepEqual(printOk(flags, value), [0x85, 0x23])
  })

  it("types one-bit fields as 0 | 1", () => {
    const bit: 0 | 1 = parseOk(flags, 0, 0).qr
    assert.equal(bit, 0)
  })

  it("handles fields wider than 32 bits", () => {
    const wide = Binary.bits({ tag: 3, value: 53 })
    const value = { tag: 5, value: Number.MAX_SAFE_INTEGER }
    assert.deepEqual(parseOk(wide, ...printOk(wide, value)), value)
  })

  it("names the field that does not fit", () => {
    const value = { qr: 1, opcode: 16, aa: 0, tc: 0, rd: 0, ra: 0, z: 0, rcode: 0 } as const
    assert.match(printFail(flags, value).message, /opcode must be an integer from 0 to 15/)
  })

  it("reports truncated input with the bytes that remain", () => {
    const error = parseFail(flags, 0x85)
    assert.equal(error.offset, 0)
    assert.equal(
      error.message,
      "byte 0: expected qr:1 opcode:4 aa:1 tc:1 rd:1 ra:1 z:3 rcode:4: 2 bytes but only 1 remain, found 0x85",
    )
  })

  it("rejects layouts that are not whole bytes or that JavaScript would reorder", () => {
    assert.throws(() => Binary.bits({ a: 3 }), /not a whole number of bytes/)
    assert.throws(() => Binary.bits({}), /not a whole number of bytes/)
    assert.throws(() => Binary.bits({ a: 0, b: 8 }), /1 to 53 bits/)
    assert.throws(() => Binary.bits({ 0: 8 }), /integer key/)
  })

  it("merges with other object grammars", () => {
    const header = G.merge(G.struct({ id: Binary.uint16 }), flags)
    assert.deepEqual(parseOk(header, 0xbe, 0xef, 0x01, 0x00), {
      id: 0xbeef,
      qr: 0,
      opcode: 0,
      aa: 0,
      tc: 0,
      rd: 1,
      ra: 0,
      z: 0,
      rcode: 0,
    })
  })
})

describe("bytes / lengthPrefixed / literal", () => {
  const png = G.struct({ body: Binary.bytes(2) }).pipe(G.prefix(Binary.literal(0x89, 0x50)))
  const label = Binary.lengthPrefixed(Binary.uint8).pipe(Binary.ascii)

  it("reads a fixed run of bytes after a magic number", () => {
    assert.deepEqual(parseOk(png, 0x89, 0x50, 1, 2), { body: Uint8Array.of(1, 2) })
    assert.deepEqual(printOk(png, { body: Uint8Array.of(1, 2) }), [0x89, 0x50, 1, 2])
    assert.equal(parseFail(png, 0x89, 0x51, 1, 2).message, "byte 1: expected 0x89 0x50, found 0x51")
  })

  it("derives the length prefix from the payload", () => {
    assert.equal(parseOk(label, 3, 0x63, 0x6f, 0x6d), "com")
    assert.deepEqual(printOk(label, "com"), [3, 0x63, 0x6f, 0x6d])
    assert.match(printFail(label, "x".repeat(256)).message, /expected uint8/)
  })

  it("reads a byte count bound earlier", () => {
    const frame = G.gen(function* () {
      const size = yield* Binary.uint16
      const body = yield* Binary.bytes(size)
      return { size, body }
    })
    assert.deepEqual(parseOk(frame, 0, 2, 7, 8), { size: 2, body: Uint8Array.of(7, 8) })
    assert.match(printFail(frame, { size: 3, body: Uint8Array.of(7, 8) }).message, /3 bytes/)
  })

  it("rejects text that is not bytes", () => {
    assert.throws(() => Binary.literal(256), /not a byte/)
    assert.equal(G.render(png), "0x89 0x50 body:<byte>{2}")
    assert.equal(
      G.render(G.struct({ id: Binary.uint16, flags: Binary.bits({ on: 1, level: 7 }) })),
      "id:<uint16> flags:<on:1 level:7>",
    )
    assert.deepEqual(Result.getOrThrow(G.parse(Binary.uint8, "ÿ")), 255)
    const error = G.parse(Binary.uint16, "aĀ")
    assert.ok(Result.isFailure(error))
    assert.deepEqual(error.failure.expected, ["a byte"])
    assert.equal(error.failure.pos, 1)
    assert.match(printFail(G.regex(/./, "char"), "€").message, /character above 0xff/)
  })
})

describe("ascii / utf8", () => {
  const ascii = Binary.lengthPrefixed(Binary.uint8).pipe(Binary.ascii)
  const utf8 = Binary.lengthPrefixed(Binary.uint8).pipe(Binary.utf8)

  it("decodes and encodes UTF-8 by byte length", () => {
    assert.equal(parseOk(utf8, 3, 0xe2, 0x82, 0xac), "€")
    assert.deepEqual(printOk(utf8, "€"), [3, 0xe2, 0x82, 0xac])
    assert.deepEqual(parseFail(utf8, 1, 0xff).expected, ["valid UTF-8"])
    assert.match(printFail(utf8, "\ud800").message, /lone surrogates/)
  })

  it("keeps a byte order mark", () => {
    assert.equal(parseOk(utf8, 3, 0xef, 0xbb, 0xbf), "﻿")
  })

  it("rejects bytes and characters outside ASCII", () => {
    assert.deepEqual(parseFail(ascii, 1, 0x80).expected, ["ASCII bytes"])
    assert.match(printFail(ascii, "é").message, /only ASCII/)
  })

  it("reports both as partial transforms", () => {
    assert.deepEqual(
      G.auditFidelity(utf8).map((entry) => entry.fidelity),
      ["partial"],
    )
  })
})

describe("codec", () => {
  const Frame = Schema.Struct({
    version: Schema.Literals([0, 1]),
    kind: Schema.Int,
    names: Schema.Array(Schema.String),
  })
  const frame = G.merge(
    Binary.bits({ version: 1, kind: 7 }),
    G.struct({
      names: Binary.lengthPrefixed(Binary.uint8).pipe(Binary.utf8, G.countPrefixed(Binary.uint8)),
    }),
  )
  const FrameFromBytes = Binary.codec(frame, Frame, { identifier: "Frame" })
  const formatIssue = SchemaIssue.makeFormatterDefault()
  const wire = Uint8Array.of(0x85, 2, 1, 0x61, 2, 0x62, 0x63)

  it("decodes and encodes a Uint8Array", () => {
    const value = Effect.runSync(Schema.decodeEffect(FrameFromBytes)(wire))
    assert.deepEqual(value, { version: 1, kind: 5, names: ["a", "bc"] })
    assert.deepEqual(Effect.runSync(Schema.encodeEffect(FrameFromBytes)(value)), wire)
  })

  it("reports decode failures by byte offset", () => {
    const issue = Effect.runSync(
      Schema.decodeEffect(FrameFromBytes)(wire.slice(0, 6)).pipe(Effect.flip),
    ).issue
    assert.match(formatIssue(issue), /byte 5: expected 2 bytes but only 1 remain, found 0x62/)
  })

  it("reports encode failures by field path", () => {
    const issue = Effect.runSync(
      Schema.encodeEffect(FrameFromBytes)({ version: 1, kind: 128, names: [] }).pipe(Effect.flip),
    ).issue
    assert.match(formatIssue(issue), /kind must be an integer from 0 to 127/)
  })

  it("handles inputs longer than one String.fromCharCode call", () => {
    const blob = Binary.lengthPrefixed(Binary.uint32)
    const body = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256)
    const printed = Result.getOrThrow(Binary.print(blob, body))
    assert.equal(printed.length, 100_004)
    assert.deepEqual(Result.getOrThrow(Binary.parse(blob, printed)), body)
  })
})
