import { Effect, flow, Predicate, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import { filter, iso, label, literal as text, partialIso, regex, take, transformNode } from "./combinators.ts"
import { type Grammar, isCount, nonByte, type Ref, toBytes, toText, type Value } from "./core.ts"
import { prefixedBy } from "./derived.ts"
import { hex, ParseError, PrintError, toSchemaIssue } from "./errors.ts"
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

export const bitSchema = Schema.Literals([0, 1])

export const uintSchema = (bits: number) => {
  assertWidth("uintSchema", bits)
  return Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** bits - 1 }))
}

export const intSchema = (bits: number) => {
  assertWidth("intSchema", bits)
  return Schema.Int.check(Schema.isBetween({ minimum: -(2 ** (bits - 1)), maximum: 2 ** (bits - 1) - 1 }))
}

export const uint64Schema = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }))

export const int64Schema = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
)

// ---------------------------------------------------------------------------
// Bytes

const isBinary = (value: string): boolean => !nonByte.test(value)

// `count` characters, each of which must be a byte.
export const takeBytes = (count: Ref<number> | number): Grammar<string> => take(count).pipe(filter(isBinary, "a byte"))

const asBytes = (inner: Grammar<string>): Grammar<Uint8Array> =>
  inner.pipe(iso({ decode: toBytes, encode: toText }), filter(Predicate.isUint8Array, "bytes"))

export const bytes = (count: Ref<number> | number): Grammar<Uint8Array> => asBytes(takeBytes(count))

export const lengthPrefixed = (length: Grammar<number>): Grammar<Uint8Array> => asBytes(prefixedBy(length, takeBytes))

export const literal = (...values: ReadonlyArray<number>): Grammar<void> => {
  if (values.some((value) => !Schema.is(uintSchema(8))(value))) {
    throw new RangeError(`literal: expected bytes, got ${values.join(", ")}`)
  }
  const name = values.map((value) => `0x${hex(Uint8Array.of(value))}`).join(" ")
  return text(toText(Uint8Array.from(values))).pipe(label(name))
}

export const ascii = (inner: Grammar<Uint8Array>): Grammar<string> =>
  inner.pipe(
    iso<Uint8Array, string>({ decode: toText, encode: toBytes }),
    filter((value: Value) => Predicate.isString(value) && /^[\0-\x7f]*$/.test(value), "ascii"),
  )

export const utf8 = (inner: Grammar<Uint8Array>): Grammar<string> =>
  inner.pipe(
    partialIso<Uint8Array, string>({
      decode: (value) => {
        try {
          return Result.succeed(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value))
        } catch {
          return Result.fail("valid UTF-8")
        }
      },
      encode: (value: string) =>
        Predicate.isString(value) && value.isWellFormed()
          ? Result.succeed(new TextEncoder().encode(value))
          : Result.fail("a string without lone surrogates"),
    }),
  )

// ---------------------------------------------------------------------------
// Fixed-width integers and floats

// `size` bytes as an unsigned big-endian (or little-endian) integer.
const word = (size: number, name: string, littleEndian = false): Grammar<bigint> =>
  takeBytes(size).pipe(
    label(name),
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
  word(size, name, littleEndian).pipe(
    iso({ decode: Number, encode: BigInt }),
    filter(Schema.is(uintSchema(8 * size)), name),
  )

const int = (size: number, name: string, littleEndian = false): Grammar<number> =>
  word(size, name, littleEndian).pipe(
    iso({ decode: (value) => Number(BigInt.asIntN(8 * size, value)), encode: BigInt }),
    filter(Schema.is(intSchema(8 * size)), name),
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

const uint64Of = (name: string, littleEndian = false): Grammar<bigint> =>
  word(8, name, littleEndian).pipe(filter(Schema.is(uint64Schema), name))

const int64Of = (name: string, littleEndian = false): Grammar<bigint> =>
  word(8, name, littleEndian).pipe(
    iso({ decode: (value) => BigInt.asIntN(64, value), encode: (value: bigint) => value }),
    filter(Schema.is(int64Schema), name),
  )

export const uint64 = uint64Of("uint64")
export const uint64le = uint64Of("uint64le", true)
export const int64 = int64Of("int64")
export const int64le = int64Of("int64le", true)

const scratch = new DataView(new ArrayBuffer(8))

// NaN payloads and signalling NaNs do not survive a parse/print round trip.
const float = (size: 4 | 8, name: string, littleEndian = false): Grammar<number> =>
  takeBytes(size).pipe(
    label(name),
    iso({
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
    // Reject values that would lose precision as float32.
    filter((value) => Predicate.isNumber(value) && (size === 8 || Object.is(Math.fround(value), value)), name),
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
    decode: (binary) => {
      const value = fromLeb128(binary)
      return Number.isSafeInteger(value)
        ? Result.succeed(value)
        : Result.fail("a varuint within the safe integer range")
    },
    encode: (value) => (isCount(value) ? Result.succeed(toLeb128(value)) : Result.fail("a non-negative safe integer")),
  }),
)

// Zigzag-encoded LEB128, as in protobuf `sint64`, for integers from -(2 ** 52) to 2 ** 52 - 1.
export const varint = leb128("varint").pipe(
  partialIso({
    decode: (binary) => {
      const value = fromLeb128(binary)
      return Number.isSafeInteger(value)
        ? Result.succeed(value % 2 === 0 ? value / 2 : -(value + 1) / 2)
        : Result.fail("a varint from -(2 ** 52) to 2 ** 52 - 1")
    },
    encode: (value) =>
      Number.isSafeInteger(value) && value >= -(2 ** 52) && value < 2 ** 52
        ? Result.succeed(toLeb128(value < 0 ? -2 * value - 1 : 2 * value))
        : Result.fail("an integer from -(2 ** 52) to 2 ** 52 - 1"),
  }),
)

// ---------------------------------------------------------------------------
// Bit fields

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
    fits: Schema.is(uintSchema(size)),
  }))

  return transformNode(
    word(width / 8, name),
    {
      // SAFETY: slots holds every key of the layout, each within its declared width.
      decode: (value) =>
        Result.succeed(
          Object.fromEntries(
            slots.map(({ key, size, shift }) => [key, Number(BigInt.asUintN(size, value >> shift))]),
          ) as Bits<Layout>,
        ),
      encode: (value: Bits<Layout>) => {
        const extra = Reflect.ownKeys(value).find((key) => !Object.hasOwn(layout, key))
        if (extra !== undefined) return Result.fail(`no field named ${String(extra)}`)
        let packed = 0n
        for (const { key, size, shift, fits } of slots) {
          const field = value[key]
          if (!fits(field)) return Result.fail(`an integer from 0 to ${2 ** size - 1} for ${key}`)
          packed |= BigInt(field) << shift
        }
        return Result.succeed(packed)
      },
    },
    "claimed-iso",
    Object.keys(layout),
  )
}

// ---------------------------------------------------------------------------
// Parsing and printing bytes: the text interpreters over a byte string

export const parse = <A>(grammar: Grammar<A>, input: Uint8Array): Result.Result<A, ParseError> =>
  Result.mapError(
    parseText(grammar, toText(input)),
    ({ pos, expected, found }) => new ParseError({ pos, line: undefined, column: undefined, expected, found }),
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
