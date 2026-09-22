import { Effect, flow, Function as F, Predicate, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import { iso, partialIso, regex, takeBytes, transformNode } from "./combinators.ts"
import { type Grammar, isCount, nonByte, type Ref, type Silent, silent, toBytes, toText, type Value } from "./core.ts"
import { prefixedBy } from "./derived.ts"
import { describeExpected, hex, PrintError, toSchemaIssue } from "./errors.ts"
import { parse as parseText } from "./parse.ts"
import { print as printText, printChecked as printCheckedText } from "./print.ts"
import { render } from "./render.ts"
import type { CodecOptions } from "./schema.ts"

export { hex } from "./errors.ts"

// ---------------------------------------------------------------------------
// Schemas for integers of a given bit width

const isWidth = (size: number): boolean => Number.isInteger(size) && size >= 1 && size <= 53

const assertWidth = (name: string, size: number): void => {
  if (!isWidth(size)) throw new RangeError(`${name}: expected a width of 1 to 53 bits, got ${size}`)
}

export const Bit = Schema.Literals([0, 1])
export const Uint = (size: number) => {
  assertWidth("Uint", size)
  return Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** size - 1 }))
}
export const Int = (size: number) => {
  assertWidth("Int", size)
  return Schema.Int.check(Schema.isBetween({ minimum: -(2 ** (size - 1)), maximum: 2 ** (size - 1) - 1 }))
}
export const Uint8 = Uint(8)
export const Uint16 = Uint(16)
export const Uint32 = Uint(32)
export const Int8 = Int(8)
export const Int16 = Int(16)
export const Int32 = Int(32)
export const Uint64 = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }))
export const Int64 = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }))

// ---------------------------------------------------------------------------
// Fixed-width integers and floats

// `size` bytes as an unsigned big-endian (or little-endian) integer.
const word = (size: number, name: string, littleEndian = false): Grammar<bigint> =>
  takeBytes(size, name).pipe(
    iso({
      decode: (binary) => {
        const bytes = littleEndian ? toBytes(binary).reverse() : toBytes(binary)
        return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
      },
      encode: (value) => {
        const bytes = Uint8Array.from({ length: size }, (_, index) =>
          Number(BigInt.asUintN(8, value >> BigInt(8 * (size - 1 - index)))),
        )
        return toText(littleEndian ? bytes.reverse() : bytes)
      },
    }),
  )

const uint = (size: number, name: string, littleEndian = false): Grammar<number> =>
  word(size, name, littleEndian).pipe(iso({ name, decode: Number, encode: BigInt, is: Schema.is(Uint(8 * size)) }))

const int = (size: number, name: string, littleEndian = false): Grammar<number> =>
  word(size, name, littleEndian).pipe(
    iso({
      name,
      decode: (value) => Number(BigInt.asIntN(8 * size, value)),
      encode: BigInt,
      is: Schema.is(Int(8 * size)),
    }),
  )

export const uint8 = uint(1, "uint8")
export const uint16 = uint(2, "uint16")
export const uint32 = uint(4, "uint32")
export const uint16le = uint(2, "uint16le", true)
export const uint32le = uint(4, "uint32le", true)

export const int8 = int(1, "int8")
export const int16 = int(2, "int16")
export const int32 = int(4, "int32")
export const int16le = int(2, "int16le", true)
export const int32le = int(4, "int32le", true)

const uint64Iso = (name: string) =>
  iso<bigint, bigint>({ name, decode: F.identity, encode: F.identity, is: Schema.is(Uint64) })
const int64Iso = (name: string) =>
  iso<bigint, bigint>({ name, decode: (value) => BigInt.asIntN(64, value), encode: F.identity, is: Schema.is(Int64) })

export const uint64 = word(8, "uint64").pipe(uint64Iso("uint64"))
export const uint64le = word(8, "uint64le", true).pipe(uint64Iso("uint64le"))
export const int64 = word(8, "int64").pipe(int64Iso("int64"))
export const int64le = word(8, "int64le", true).pipe(int64Iso("int64le"))

const scratch = new DataView(new ArrayBuffer(8))

// NaN payloads and signalling NaNs do not survive a parse/print round trip.
const float = (size: 4 | 8, name: string, littleEndian = false): Grammar<number> =>
  takeBytes(size, name).pipe(
    iso({
      name,
      // Reject values that would lose precision as float32.
      is: (value) => Predicate.isNumber(value) && (size === 8 || Object.is(Math.fround(value), value)),
      decode: (binary) => {
        for (let index = 0; index < size; index++) scratch.setUint8(index, binary.charCodeAt(index))
        return size === 4 ? scratch.getFloat32(0, littleEndian) : scratch.getFloat64(0, littleEndian)
      },
      encode: (value) => {
        if (size === 4) scratch.setFloat32(0, value, littleEndian)
        else scratch.setFloat64(0, value, littleEndian)
        let binary = ""
        for (let index = 0; index < size; index++) binary += String.fromCharCode(scratch.getUint8(index))
        return binary
      },
    }),
  )

export const float32 = float(4, "float32")
export const float64 = float(8, "float64")
export const float32le = float(4, "float32le", true)
export const float64le = float(8, "float64le", true)

// ---------------------------------------------------------------------------
// Variable-length integers

// Parsing accepts padded encodings of any length; printing writes the shortest one.
const leb128 = (name: string): Grammar<string> => regex(/[\x80-\xff]*[\0-\x7f]/, name)

const fromLeb128 = (binary: string): number => {
  let value = 0
  for (let index = binary.length - 1; index >= 0; index--) {
    value = value * 128 + (binary.charCodeAt(index) & 0x7f)
  }
  return value
}

const toLeb128 = (value: number): string => {
  let binary = ""
  let rest = value
  while (rest >= 128) {
    binary += String.fromCharCode((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  return binary + String.fromCharCode(rest)
}

// Unsigned LEB128 within the safe integer range.
export const varuint = leb128("varuint").pipe(
  partialIso({
    name: "varuint",
    decode: (binary) => {
      const value = fromLeb128(binary)
      return Number.isSafeInteger(value)
        ? Result.succeed(value)
        : Result.fail({ message: "a varuint within the safe integer range" })
    },
    encode: (value) =>
      isCount(value)
        ? Result.succeed(toLeb128(value))
        : Result.fail({ message: "expected a non-negative safe integer" }),
  }),
)

// Zigzag-encoded LEB128, as in protobuf `sint64`, for integers from -(2 ** 52) to 2 ** 52 - 1.
export const varint = leb128("varint").pipe(
  partialIso({
    name: "varint",
    decode: (binary) => {
      const value = fromLeb128(binary)
      return Number.isSafeInteger(value)
        ? Result.succeed(value % 2 === 0 ? value / 2 : -(value + 1) / 2)
        : Result.fail({ message: "a varint from -(2 ** 52) to 2 ** 52 - 1" })
    },
    encode: (value) =>
      Number.isSafeInteger(value) && value >= -(2 ** 52) && value < 2 ** 52
        ? Result.succeed(toLeb128(value < 0 ? -2 * value - 1 : 2 * value))
        : Result.fail({ message: "expected an integer from -(2 ** 52) to 2 ** 52 - 1" }),
  }),
)

// ---------------------------------------------------------------------------
// Bit fields, byte strings, and text

export type BitLayout = Readonly<Record<string, number>>

export type Bits<Layout extends BitLayout> = {
  readonly [K in keyof Layout]: Layout[K] extends 1 ? 0 | 1 : number
}

// Pack named fields, most significant first, into a whole number of bytes.
export const bits = <const Layout extends BitLayout>(layout: Layout): Grammar<Bits<Layout>> => {
  const fields = Object.entries(layout)
  const name = fields.map(([key, size]) => `${key}:${size}`).join(" ")
  const width = fields.reduce((total, [, size]) => total + size, 0)
  if (width % 8 !== 0 || fields.some(([key, size]) => /^\d+$/.test(key) || !isWidth(size))) {
    throw new RangeError(
      `bits: expected non-integer field names, widths of 1 to 53 bits, and a whole number of bytes, got ${name}`,
    )
  }
  let shift = BigInt(width)
  const slots = fields.map(([key, size]) => ({
    key,
    size,
    shift: (shift -= BigInt(size)),
    fits: Schema.is(Uint(size)),
  }))

  return transformNode(
    word(width / 8, name),
    {
      name,
      // SAFETY: slots holds every key of the layout, each within its declared width.
      decode: (value) =>
        Result.succeed(
          Object.fromEntries(
            slots.map(({ key, size, shift }) => [key, Number(BigInt.asUintN(size, value >> shift))]),
          ) as Bits<Layout>,
        ),
      encode: (value: Bits<Layout>) => {
        const extra = Reflect.ownKeys(value).find((key) => !Object.hasOwn(layout, key))
        if (extra !== undefined) return Result.fail({ message: `unexpected field ${String(extra)}` })
        let packed = 0n
        for (const { key, size, shift, fits } of slots) {
          const field = value[key]
          if (!fits(field)) return Result.fail({ message: `${key} must be an integer from 0 to ${2 ** size - 1}` })
          packed |= BigInt(field) << shift
        }
        return Result.succeed(packed)
      },
    },
    "claimed-iso",
    Object.keys(layout),
  )
}

const asBytes = iso<string, Uint8Array>({
  name: "bytes",
  is: Predicate.isUint8Array,
  decode: toBytes,
  encode: toText,
})

export const bytes = (count: Ref<number> | number): Grammar<Uint8Array> => takeBytes(count).pipe(asBytes)

export const lengthPrefixed = (length: Grammar<number>): Grammar<Uint8Array> =>
  prefixedBy(length, takeBytes).pipe(asBytes)

export const literal = (...values: ReadonlyArray<number>): Silent => {
  if (values.some((value) => !Schema.is(Uint8)(value))) {
    throw new RangeError(`literal: expected bytes, got ${values.join(", ")}`)
  }
  return silent({
    _tag: "Literal",
    value: toText(Uint8Array.from(values)),
    name: values.map((value) => `0x${hex(Uint8Array.of(value))}`).join(" "),
  })
}

export const ascii = iso<Uint8Array, string>({
  name: "ascii",
  is: (value) => Predicate.isString(value) && /^[\0-\x7f]*$/.test(value),
  decode: toText,
  encode: toBytes,
})

export const utf8 = partialIso<Uint8Array, string>({
  name: "utf8",
  decode: (value) => {
    try {
      return Result.succeed(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value))
    } catch {
      return Result.fail({ message: "valid UTF-8" })
    }
  },
  encode: (value) =>
    value.isWellFormed()
      ? Result.succeed(new TextEncoder().encode(value))
      : Result.fail({ message: "expected a string without lone surrogates" }),
})

// ---------------------------------------------------------------------------
// Parsing and printing bytes: the text interpreters over a byte string

export class ParseError extends Schema.TaggedError<ParseError>()("BinaryParseError", {
  offset: Schema.Finite,
  expected: Schema.Array(Schema.String),
  found: Schema.UndefinedOr(Schema.Finite),
}) {
  override get message(): string {
    const found = this.found === undefined ? "end of input" : `0x${hex(Uint8Array.of(this.found))}`
    return `byte ${this.offset}: expected ${describeExpected(this.expected)}, found ${found}`
  }
}

export const parse = <A>(grammar: Grammar<A>, input: Uint8Array): Result.Result<A, ParseError> =>
  Result.mapError(
    parseText(grammar, toText(input)),
    ({ pos, expected, found }) => new ParseError({ offset: pos, expected, found: found?.charCodeAt(0) }),
  )

const toByteResult = (
  value: Value,
  printed: Result.Result<string, PrintError>,
): Result.Result<Uint8Array, PrintError> =>
  Result.flatMap(printed, (binary) =>
    nonByte.test(binary)
      ? Result.fail(
          new PrintError({ issue: { _tag: "InvalidValue", expected: "only bytes to be printed", actual: value } }),
        )
      : Result.succeed(toBytes(binary)),
  )

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<Uint8Array, PrintError> =>
  toByteResult(value, printText(grammar, value))

export const printChecked = <A>(grammar: Grammar<A>, value: A): Result.Result<Uint8Array, PrintError> =>
  toByteResult(value, printCheckedText(grammar, value))

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], Uint8Array>({
        decode: flow(
          (input) => parse(grammar, input),
          Effect.fromResult,
          Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message })),
        ),
        encode: flow(
          // SAFETY: the target schema encodes to A.
          (value) => printChecked(grammar, value as A),
          Effect.fromResult,
          Effect.mapError(({ issue }) => toSchemaIssue(issue)),
        ),
      }),
    ),
    Schema.annotate({ identifier: options?.identifier, description: render(grammar) }),
  )
