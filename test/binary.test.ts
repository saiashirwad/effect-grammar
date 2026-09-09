import assert from "node:assert/strict"

import { Result, Schema } from "effect"
import * as FastCheck from "effect/testing/FastCheck"
import { describe, it } from "vitest"

import { message } from "../examples/binary.ts"
import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"
import { lawsFor } from "../src/testing.ts"
import { bytes } from "./helpers.ts"

const encoder = new TextEncoder()

const packet = G.gen(function* () {
  yield* B.literal(bytes(0xca, 0xfe))
  const length = yield* B.be.uint16
  const payload = yield* B.bytes(length)
  return { length, payload }
})

describe("binary primitives", () => {
  it("round-trips every possible byte without decoding text", () => {
    for (let value = 0; value < 256; value++) {
      assert.equal(Result.getOrThrow(B.parse(B.byte, bytes(value))), value)
      assert.deepEqual(Result.getOrThrow(B.printChecked(B.byte, value)), bytes(value))
    }
  })

  it("reads both byte orders from a view with a nonzero offset", () => {
    const input = bytes(99, 0x89, 0xab, 0xcd, 0xef, 99).subarray(1, 5)
    assert.equal(Result.getOrThrow(B.parse(B.be.uint32, input)), 0x89abcdef)
    assert.equal(Result.getOrThrow(B.parse(B.le.uint32, input)), 0xefcdab89)
    assert.equal(Result.getOrThrow(B.parse(B.be.uint16, input.subarray(0, 2))), 0x89ab)
    assert.equal(Result.getOrThrow(B.parse(B.le.uint16, input.subarray(0, 2))), 0xab89)
    assert.deepEqual(Result.getOrThrow(B.print(B.be.uint32, 0x89abcdef)), input)
    assert.deepEqual(Result.getOrThrow(B.print(B.le.uint32, 0xefcdab89)), input)
  })

  it("rejects out-of-range and non-integer values instead of truncating them", () => {
    for (const [grammar, max] of [
      [B.byte, 255],
      [B.be.uint16, 65535],
      [B.le.uint32, 4294967295],
    ] as const) {
      for (const value of [-1, max + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.ok(Result.isFailure(B.print(grammar, value)))
      }
      assert.ok(Result.isSuccess(B.printChecked(grammar, max)))
      assert.ok(Result.isSuccess(B.printChecked(grammar, 0)))
    }
  })

  it("requires enough input and consumes the whole input", () => {
    for (const input of [bytes(), bytes(1), bytes(1, 2, 3)]) {
      assert.ok(Result.isFailure(B.parse(B.be.uint16, input)))
    }
    assert.ok(Result.isFailure(B.parse(B.bytes(2), bytes(1))))
    assert.ok(Result.isSuccess(B.parse(B.bytes(0), bytes())))
    assert.ok(Result.isFailure(B.parse(B.bytes(0), bytes(1))))
    assert.ok(Result.isFailure(B.print(B.bytes(2), bytes(1))))
  })

  it("reports the first mismatching literal byte and EOF", () => {
    const grammar = B.literal(bytes(1, 2, 255))
    const result = B.parse(grammar, bytes(1, 2, 128))
    assert.ok(Result.isFailure(result))
    assert.equal(result.failure._tag, "BinaryParseError")
    assert.equal(result.failure.pos, 2)
    assert.equal(result.failure.found, 128)
    assert.equal(result.failure.message, "byte 2: expected 0xff, found 0x80")
    const eof = B.parse(grammar, bytes(1, 2))
    assert.ok(Result.isFailure(eof))
    assert.equal(eof.failure.message, "byte 2: expected 0xff, found end of input")
  })

  it("copies literals, parsed payloads, and printed buffers", () => {
    const source = Buffer.from([0, 255])
    const literal = B.literal(source)
    const payload = Result.getOrThrow(B.parse(B.bytes(2), source))
    const printed = Result.getOrThrow(B.print(B.bytes(2), source))
    assert.deepEqual(Result.getOrThrow(B.printChecked(B.bytes(2), source)), bytes(0, 255))
    source.fill(42)
    assert.deepEqual(payload, bytes(0, 255))
    assert.deepEqual(printed, bytes(0, 255))
    const first = Result.getOrThrow(B.print(literal, undefined))
    first.fill(42)
    assert.deepEqual(Result.getOrThrow(B.print(literal, undefined)), bytes(0, 255))
    assert.ok(Result.isSuccess(B.parse(literal, bytes(0, 255))))
  })

  it("rejects invalid static counts when constructing the grammar", () => {
    for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => B.bytes(count), /non-negative safe integer/)
    }
  })
})

describe("binary composition", () => {
  it("parses and prints length-prefixed packets and reports the payload path", () => {
    const value = { length: 3, payload: bytes(0, 128, 255) }
    const input = bytes(0xca, 0xfe, 0, 3, 0, 128, 255)
    assert.deepEqual(Result.getOrThrow(B.parse(packet, input)), value)
    assert.deepEqual(Result.getOrThrow(B.printChecked(packet, value)), input)
    assert.ok(Result.isFailure(B.parse(packet, input.subarray(0, 6))))
    const result = B.print(packet, { length: 2, payload: value.payload })
    assert.ok(Result.isFailure(result))
    assert.match(result.failure.message, /^\.payload: expected 2 bytes/)
  })

  it("preserves arbitrary binary payloads through a packet round trip", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.uint8Array({ maxLength: 1024 }), (payload) => {
        const value = { length: payload.length, payload }
        const printed = Result.getOrThrow(B.printChecked(packet, value))
        assert.deepEqual(Result.getOrThrow(B.parse(packet, printed)), value)
      }),
    )
  })

  it("backtracks after a partially matched literal", () => {
    const grammar = G.choice(
      B.literal(bytes(1, 2)).pipe(G.as("first")),
      B.literal(bytes(1, 3)).pipe(G.as("second")),
    )
    assert.equal(Result.getOrThrow(B.parse(grammar, bytes(1, 3))), "second")
    assert.deepEqual(Result.getOrThrow(B.printChecked(grammar, "second")), bytes(1, 3))
  })

  it("shares wrappers, separators, optional values, and exact repetition", () => {
    const list = G.between(
      B.literal(bytes(0xaa)),
      G.sepBy(B.byte, B.literal(bytes(0xff))),
      B.literal(bytes(0xbb)),
    )
    assert.deepEqual(Result.getOrThrow(B.printChecked(list, [1, 2])), bytes(0xaa, 1, 0xff, 2, 0xbb))
    assert.equal(Result.getOrThrow(B.parse(G.optional(B.byte), bytes())), undefined)
    assert.deepEqual(Result.getOrThrow(B.printChecked(G.optional(B.byte), undefined)), bytes())
    const repeated = G.gen(function* () {
      const count = yield* B.byte
      const values = yield* G.repeat(B.le.uint16, count)
      return { count, values }
    })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(repeated, { count: 2, values: [256, 257] })),
      bytes(2, 0, 1, 1, 1),
    )
  })

  it("dispatches dependent payloads by a numeric tag", () => {
    const grammar = G.gen(function* () {
      const kind = yield* G.choice(
        B.literal(bytes(1)).pipe(G.as(1)),
        B.literal(bytes(2)).pipe(G.as(2)),
      )
      const value = yield* G.matchValue(kind, [
        [1, B.be.uint16],
        [2, B.bytes(2)],
      ] as const)
      return { kind, value }
    })
    assert.deepEqual(Result.getOrThrow(B.parse(grammar, bytes(1, 0, 5))), { kind: 1, value: 5 })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(grammar, { kind: 2, value: bytes(0, 255) })),
      bytes(2, 0, 255),
    )
  })

  it("supports refs to byte payload lengths", () => {
    const grammar = G.gen(function* () {
      const first = yield* B.bytes(2)
      const second = yield* B.bytes(first.length)
      return { first, second }
    })
    const value = { first: bytes(0, 1), second: bytes(2, 3) }
    assert.deepEqual(Result.getOrThrow(B.printChecked(grammar, value)), bytes(0, 1, 2, 3))
  })

  it("checks ambiguous choices and transforms using the binary parser", () => {
    const ambiguous = G.choice(
      B.literal(bytes(1)).pipe(G.as("a")),
      B.literal(bytes(1)).pipe(G.as("b")),
    )
    assert.ok(Result.isSuccess(B.print(ambiguous, "b")))
    const result = B.printChecked(ambiguous, "b")
    assert.ok(Result.isFailure(result))
    assert.match(result.failure.message, /prints as \[0x01\]/)
    const checked = G.checkedChoice(
      B.literal(bytes(1)).pipe(G.as("a")),
      B.literal(bytes(1)).pipe(G.as("b")),
      B.literal(bytes(2)).pipe(G.as("b")),
    )
    assert.deepEqual(Result.getOrThrow(B.printChecked(checked, "b")), bytes(2))
    const broken = B.byte.pipe(
      G.transform({ decode: (value) => value + 1, encode: (value) => value }),
    )
    assert.ok(Result.isFailure(B.printChecked(broken, 1)))
  })

  it("retains the outer environment for checked choices", () => {
    const grammar = G.gen(function* () {
      const count = yield* B.byte
      const payload = yield* G.checkedChoice(B.bytes(count), B.bytes(1))
      return { count, payload }
    })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(grammar, { count: 2, payload: bytes(0, 255) })),
      bytes(2, 0, 255),
    )
  })
})

describe("binary validation and compilation", () => {
  it("compiles and renders a binary packet", () => {
    const compiled = B.compile(packet)
    assert.equal(compiled.render, "[0xca 0xfe] length:<uint16BE> payload:<byte>{length}")
    assert.deepEqual(compiled.fidelity, [])
    const input = bytes(0xca, 0xfe, 0, 0)
    const value = Result.getOrThrow(compiled.parse(input))
    assert.deepEqual(Result.getOrThrow(compiled.print(value)), input)
    assert.deepEqual(Result.getOrThrow(compiled.printChecked(value)), input)
  })

  it("rejects text terminals in binary grammars and vice versa", () => {
    const check = <A>(grammar: G.Grammar<A>): void => {
      assert.throws(() => B.compile(grammar), /cannot be used with binary input/)
      assert.ok(Result.isFailure(B.parse(grammar, bytes())))
    }
    check(G.literal("x"))
    check(G.regex(/x*/, "xs"))
    assert.ok(Result.isFailure(B.print(G.regex(/x*/, "xs"), "")))
    assert.throws(() => G.compile(B.byte), /cannot be used with text input/)
    assert.ok(Result.isFailure(G.parse(B.byte, "x")))
    assert.ok(Result.isFailure(G.print(B.byte, 1)))
    assert.ok(Result.isSuccess(B.parse(G.empty, bytes())))
  })

  it("validates dependent byte counts and rejects escaped refs", () => {
    let escaped: G.Grammar<Uint8Array> | undefined
    G.gen(function* () {
      const count = yield* B.byte
      escaped = B.bytes(count)
      return count
    })
    assert.throws(() => B.compile(escaped!), /bytes: uses a ref bound by a gen/)
    assert.ok(Result.isFailure(B.parse(escaped!, bytes(1))))
    assert.ok(Result.isFailure(B.print(escaped!, bytes(1))))
  })

  it("rejects zero-width unbounded repetition and guards it at runtime", () => {
    const check = <A>(grammar: G.Grammar<A>): void => {
      assert.equal(B.validate(grammar).length, 1)
      assert.throws(() => B.compile(grammar), /could not make progress/)
      assert.ok(Result.isFailure(B.parse(grammar, bytes())))
    }
    check(G.many(B.bytes(0)))
    check(G.many(B.literal(bytes())))
  })
})

describe("binary codec and laws", () => {
  const Packet = Schema.Struct({ length: Schema.Finite, payload: Schema.Uint8Array })
  const PacketCodec = B.codec(packet, Packet, { identifier: "Packet" })
  const input = bytes(0xca, 0xfe, 0, 2, 7, 9)
  const value = { length: 2, payload: bytes(7, 9) }

  it("decodes bytes to the schema value and encodes it back", () => {
    assert.deepEqual(Schema.decodeSync(PacketCodec)(input), value)
    assert.deepEqual(Schema.encodeSync(PacketCodec)(value), input)
    assert.throws(() => Schema.decodeUnknownSync(PacketCodec)("cafe"))
    assert.throws(
      () => Schema.encodeSync(PacketCodec)({ length: 3, payload: bytes(7, 9) }),
      /3 bytes/,
    )
  })

  it("checks the round-trip laws with the binary parser", () => {
    const laws = lawsFor(B.format)
    laws.assertPrintParse(packet, value)
    assert.deepEqual(laws.assertParsePrintCanonical(packet, input), input)
    assert.throws(
      () => laws.assertParsePrintCanonical(packet, bytes(1)),
      /parse failed for \[0x01\]/,
    )
    laws.checkPrintParse(
      packet,
      FastCheck.uint8Array({ maxLength: 64 }).map((payload) => ({
        length: payload.length,
        payload,
      })),
    )
    laws.checkCanonicalization(
      packet,
      FastCheck.uint8Array({ maxLength: 8 }).map((payload) =>
        bytes(0xca, 0xfe, 0, payload.length, ...payload),
      ),
    )
  })
})

describe("numbers", () => {
  it("reads and writes every kind and width in both byte orders", () => {
    const check = <A>(grammar: G.Grammar<A>, input: Uint8Array, value: A): void => {
      assert.equal(Result.getOrThrow(B.parse(grammar, input)), value)
      assert.deepEqual(Result.getOrThrow(B.printChecked(grammar, value)), input)
    }
    check(B.int8, bytes(0xff), -1)
    check(B.le.int16, bytes(0xfe, 0xff), -2)
    check(B.be.int32, bytes(0x80, 0, 0, 0), -2147483648)
    check(B.le.uint32, bytes(1, 0, 0, 0), 1)
    check(B.be.uint64, bytes(0, 0, 0, 0, 0, 0, 0, 1), 1n)
    check(B.le.int64, bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), -1n)
    check(B.be.float32, bytes(0x3f, 0x80, 0, 0), 1)
    check(B.le.float64, bytes(0, 0, 0, 0, 0, 0, 0xf0, 0x3f), 1)
    assert.equal(G.render(B.le.float64), "<float64LE>")
    assert.equal(G.render(B.int8), "<int8>")
  })

  it("rejects values outside the kind's range or of the wrong integer type", () => {
    assert.ok(Result.isFailure(B.print(B.int8, 128)))
    assert.ok(Result.isFailure(B.print(B.int8, -129)))
    assert.ok(Result.isFailure(B.print(B.be.uint64, -1n)))
    assert.ok(Result.isFailure(B.print(B.be.uint64, 2n ** 64n)))
    assert.ok(Result.isFailure(B.print(B.int8, 1.5)))
  })

  it("flags a float32 print that does not read back exactly", () => {
    assert.ok(Result.isSuccess(B.printChecked(B.be.float32, 0.5)))
    assert.ok(Result.isFailure(B.printChecked(B.be.float32, 0.1)))
  })
})

describe("varint", () => {
  it("round-trips LEB128 and zigzag values", () => {
    for (const [value, encoded] of [
      [0, bytes(0)],
      [127, bytes(127)],
      [128, bytes(0x80, 1)],
      [300, bytes(0xac, 0x02)],
      [Number.MAX_SAFE_INTEGER, bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f)],
    ] as const) {
      assert.equal(Result.getOrThrow(B.parse(B.varuint, encoded)), value)
      assert.deepEqual(Result.getOrThrow(B.printChecked(B.varuint, value)), encoded)
    }
    for (const [value, encoded] of [
      [0, bytes(0)],
      [-1, bytes(1)],
      [1, bytes(2)],
      [-64, bytes(127)],
      [64, bytes(0x80, 1)],
    ] as const) {
      assert.equal(Result.getOrThrow(B.parse(B.varint, encoded)), value)
      assert.deepEqual(Result.getOrThrow(B.printChecked(B.varint, value)), encoded)
    }
    FastCheck.assert(
      FastCheck.property(FastCheck.integer(), (value) => {
        assert.ok(Result.isSuccess(B.printChecked(B.varint, value)))
      }),
    )
  })

  it("rejects truncated, oversized, and non-integer values", () => {
    assert.ok(Result.isFailure(B.parse(B.varuint, bytes(0x80))))
    assert.ok(
      Result.isFailure(
        B.parse(B.varuint, bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f)),
      ),
    )
    assert.ok(Result.isFailure(B.print(B.varuint, -1)))
    assert.ok(Result.isFailure(B.print(B.varint, 1.5)))
    assert.ok(Result.isFailure(B.print(B.varint, Number.MAX_SAFE_INTEGER)))
  })
})

describe("utf8 and bitfield", () => {
  it("decodes UTF-8 by byte length and rejects malformed bytes", () => {
    const text = B.utf8(3)
    assert.equal(Result.getOrThrow(B.parse(text, bytes(0xe2, 0x82, 0xac))), "€")
    assert.deepEqual(Result.getOrThrow(B.printChecked(text, "€")), bytes(0xe2, 0x82, 0xac))
    assert.ok(Result.isFailure(B.parse(text, bytes(0xff, 0xff, 0xff))))
    assert.ok(Result.isFailure(B.print(text, "abcd")))
  })

  it("splits a word into fields most significant first", () => {
    const header = B.bitfield(B.byte, { version: 4, ihl: 4 })
    assert.deepEqual(Result.getOrThrow(B.parse(header, bytes(0x45))), { version: 4, ihl: 5 })
    assert.deepEqual(Result.getOrThrow(B.printChecked(header, { version: 4, ihl: 5 })), bytes(0x45))
    assert.ok(Result.isFailure(B.print(header, { version: 16, ihl: 5 })))
    const flags = B.bitfield(B.be.uint16, { flags: 3, offset: 13 })
    assert.deepEqual(Result.getOrThrow(B.parse(flags, bytes(0x40, 0x05))), { flags: 2, offset: 5 })
    const partial = B.bitfield(B.byte, { low: 4 })
    assert.ok(Result.isFailure(B.parse(partial, bytes(0x10))))
    assert.throws(() => B.bitfield(B.byte, { bad: 0 }), /positive integer width/)
  })
})

describe("mapRef and derive", () => {
  it("computes a byte count from a ref with arithmetic", () => {
    const grammar = G.gen(function* () {
      const words = yield* B.byte
      const body = yield* B.bytes(G.mapRef(words, (n) => n * 4, "bytesOf"))
      return { words, body }
    })
    assert.deepEqual(Result.getOrThrow(B.parse(grammar, bytes(1, 9, 9, 9, 9))), {
      words: 1,
      body: bytes(9, 9, 9, 9),
    })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(grammar, { words: 1, body: bytes(9, 9, 9, 9) })),
      bytes(1, 9, 9, 9, 9),
    )
    assert.ok(Result.isFailure(B.print(grammar, { words: 2, body: bytes(9, 9, 9, 9) })))
    assert.equal(G.render(grammar), "words:<uint8> body:<byte>{bytesOf(words)}")
  })

  it("derives a length prefix on print and checks it on parse", () => {
    const message = G.gen(function* () {
      const length = yield* B.varuint
      const text = yield* B.utf8(length)
      yield* G.derive(
        length,
        G.mapRef(text, (value) => encoder.encode(value).length),
      )
      return { text }
    })
    assert.deepEqual(Result.getOrThrow(B.parse(message, bytes(3, 0xe2, 0x82, 0xac))), { text: "€" })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(message, { text: "hi" })),
      bytes(2, 0x68, 0x69),
    )
    const fixed = G.gen(function* () {
      const length = yield* B.byte
      const payload = yield* B.bytes(2)
      yield* G.derive(length, payload.length)
      return { payload }
    })
    assert.deepEqual(Result.getOrThrow(B.parse(fixed, bytes(2, 7, 9))), { payload: bytes(7, 9) })
    const mismatch = B.parse(fixed, bytes(3, 7, 9))
    assert.ok(Result.isFailure(mismatch))
    assert.deepEqual(mismatch.failure.expected, ["a derived 2"])
    assert.equal(G.render(message), "f(text):<varuint> text:<byte>{f(text)}")
  })

  it("keeps a returned length when the value carries one and checks agreement", () => {
    const grammar = G.gen(function* () {
      const length = yield* B.byte
      const payload = yield* B.bytes(length)
      yield* G.derive(length, payload.length)
      return { length, payload }
    })
    assert.deepEqual(
      Result.getOrThrow(B.printChecked(grammar, { length: 1, payload: bytes(7) })),
      bytes(1, 7),
    )
    const wrong = B.print(grammar, { length: 2, payload: bytes(7) })
    assert.ok(Result.isFailure(wrong))
    assert.equal(wrong.failure.message, ".length: expected 1, got 2")
  })

  it("rejects a derive whose target is not a whole binding of this gen", () => {
    assert.throws(
      () =>
        G.gen(function* () {
          const payload = yield* B.bytes(2)
          yield* G.derive(payload.length, payload.length)
          return payload
        }),
      /whole binding/,
    )
    let escaped: G.Silent | undefined
    G.gen(function* () {
      const length = yield* B.byte
      const payload = yield* B.bytes(length)
      escaped = G.derive(length, payload.length)
      return { length, payload }
    })
    assert.throws(() => G.seq(escaped!), /bound by the gen that yields/)
    const free = G.between(escaped!, B.byte, G.empty)
    assert.match(B.validate(free)[0]?.message ?? "", /yielded directly/)
    assert.ok(Result.isFailure(B.parse(free, bytes(1))))
    assert.ok(Result.isFailure(B.print(free, 1)))
    assert.throws(
      () =>
        G.gen(function* () {
          const length = yield* B.byte
          const payload = yield* B.bytes(length)
          return payload
        }),
      /derive it/,
    )
  })
})

describe("example message", () => {
  it("derives the length, so values carry only the header and text", () => {
    const value = { header: { version: 2, priority: 1 }, text: "€" }
    const input = bytes(0xca, 0xfe, 0x21, 0x03, 0xe2, 0x82, 0xac)
    assert.deepEqual(Result.getOrThrow(B.parse(message, input)), value)
    assert.deepEqual(Result.getOrThrow(B.printChecked(message, value)), input)
    assert.ok(Result.isFailure(B.parse(message, bytes(0xca, 0xfe, 0x21, 0x02, 0xe2, 0x82, 0xac))))
  })
})
