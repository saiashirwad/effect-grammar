import { Function as F, Predicate, Result, Schema } from "effect"

import { type CodecOptions, codecFrom } from "./codec.ts"
import { iso, partialIso, prefixedBy, regex, takeBytes, withKeys } from "./combinators.ts"
import {
  type Grammar,
  type GrammarInternal,
  type Ref,
  type Silent,
  silent,
  type Value,
} from "./core.ts"
import { isCount, nonByte } from "./env.ts"
import { describeExpected, hex, PrintError } from "./errors.ts"
import { parse as parseText } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"

export { hex } from "./errors.ts"

const assertWidth = (name: string, size: number): void => {
  if (!Number.isInteger(size) || size < 1 || size > 53) {
    throw new RangeError(`${name}: expected a width of 1 to 53 bits, got ${size}`)
  }
}

export const Bit = Schema.Literals([0, 1])
export const Uint = (size: number) => {
  assertWidth("Uint", size)
  return Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** size - 1 }))
}
export const Int = (size: number) => {
  assertWidth("Int", size)
  return Schema.Int.check(
    Schema.isBetween({ minimum: -(2 ** (size - 1)), maximum: 2 ** (size - 1) - 1 }),
  )
}
export const Uint8 = Uint(8)
export const Uint16 = Uint(16)
export const Uint32 = Uint(32)
export const Int8 = Int(8)
export const Int16 = Int(16)
export const Int32 = Int(32)
export const Uint64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n }),
)
export const Int64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
)

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

const toText = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return binary
}

const toBytes = (binary: string): Uint8Array =>
  Uint8Array.from(binary, (char) => char.charCodeAt(0))

const word = (size: number, name: string, littleEndian = false): Grammar<bigint> =>
  takeBytes(size, name).pipe(
    iso({
      decode: (binary) => {
        const bytes = littleEndian ? toBytes(binary).reverse() : toBytes(binary)
        return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
      },
      // A negative value is written as its two's complement.
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
    iso({ name, decode: Number, encode: BigInt, is: Schema.is(Uint(8 * size)) }),
  )

const int = (size: number, name: string, littleEndian = false): Grammar<number> =>
  word(size, name, littleEndian).pipe(
    iso({
      name,
      decode: (value) => Number(BigInt.asIntN(8 * size, value)),
      encode: BigInt,
      is: Schema.is(Int(8 * size)),
    }),
  )

const uint64Of = (name: string, littleEndian = false): Grammar<bigint> =>
  word(8, name, littleEndian).pipe(
    iso({ name, decode: F.identity, encode: F.identity, is: Schema.is(Uint64) }),
  )

const int64Of = (name: string, littleEndian = false): Grammar<bigint> =>
  word(8, name, littleEndian).pipe(
    iso({
      name,
      decode: (value) => BigInt.asIntN(64, value),
      encode: F.identity,
      is: Schema.is(Int64),
    }),
  )

const float = (size: 4 | 8, name: string, littleEndian = false): Grammar<number> =>
  takeBytes(size, name).pipe(
    iso({
      name,
      // A float32 holds only the numbers that survive rounding to single precision.
      is: (value) =>
        Predicate.isNumber(value) && (size === 8 || Object.is(Math.fround(value), value)),
      decode: (binary) => {
        const view = new DataView(toBytes(binary).buffer)
        return size === 4 ? view.getFloat32(0, littleEndian) : view.getFloat64(0, littleEndian)
      },
      encode: (value) => {
        const view = new DataView(new ArrayBuffer(size))
        if (size === 4) view.setFloat32(0, value, littleEndian)
        else view.setFloat64(0, value, littleEndian)
        return toText(new Uint8Array(view.buffer))
      },
    }),
  )

export const uint8 = uint(1, "uint8")
export const uint16 = uint(2, "uint16")
export const uint32 = uint(4, "uint32")
export const uint64 = uint64Of("uint64")
export const uint16le = uint(2, "uint16le", true)
export const uint32le = uint(4, "uint32le", true)
export const uint64le = uint64Of("uint64le", true)

export const int8 = int(1, "int8")
export const int16 = int(2, "int16")
export const int32 = int(4, "int32")
export const int64 = int64Of("int64")
export const int16le = int(2, "int16le", true)
export const int32le = int(4, "int32le", true)
export const int64le = int64Of("int64le", true)

export const float32 = float(4, "float32")
export const float64 = float(8, "float64")
export const float32le = float(4, "float32le", true)
export const float64le = float(8, "float64le", true)

/**
 * Unsigned LEB128 within the safe integer range. Parsing accepts padded
 * encodings of up to eight bytes; printing writes the shortest one.
 */
export const varuint = regex(/[\x80-\xff]{0,7}[\0-\x7f]/, "varuint").pipe(
  partialIso({
    name: "varuint",
    decode: (binary) => {
      const value = toBytes(binary).reduceRight((rest, byte) => rest * 128 + (byte & 0x7f), 0)
      return Number.isSafeInteger(value)
        ? Result.succeed(value)
        : Result.fail({ message: "a varuint within the safe integer range" })
    },
    encode: (value) => {
      if (!isCount(value)) return Result.fail({ message: "expected a non-negative safe integer" })
      const bytes: Array<number> = []
      let rest = value
      while (rest >= 128) {
        bytes.push((rest % 128) | 0x80)
        rest = Math.floor(rest / 128)
      }
      bytes.push(rest)
      return Result.succeed(toText(Uint8Array.from(bytes)))
    },
  }),
)

/** Zigzag-encoded LEB128, as in protobuf `sint64`, for integers from -(2 ** 52) to 2 ** 52 - 1. */
export const varint = varuint.pipe(
  partialIso({
    name: "varint",
    decode: (value) => Result.succeed(value % 2 === 0 ? value / 2 : -(value + 1) / 2),
    encode: (value) =>
      Number.isSafeInteger(value) && value >= -(2 ** 52) && value < 2 ** 52
        ? Result.succeed(value < 0 ? -2 * value - 1 : 2 * value)
        : Result.fail({ message: "expected an integer from -(2 ** 52) to 2 ** 52 - 1" }),
  }),
)

export type BitLayout = Readonly<Record<string, number>>

export type Bits<Layout extends BitLayout> = {
  readonly [K in keyof Layout]: Layout[K] extends 1 ? 0 | 1 : number
}

export const bits = <const Layout extends BitLayout>(layout: Layout): Grammar<Bits<Layout>> => {
  const fields = Object.entries(layout)
  const name = fields.map(([key, size]) => `${key}:${size}`).join(" ")
  const width = fields.reduce((total, [, size]) => total + size, 0)
  if (
    width % 8 !== 0 ||
    fields.some(
      ([key, size]) => /^\d+$/.test(key) || !Number.isInteger(size) || size < 1 || size > 53,
    )
  ) {
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

  const grammar = word(width / 8, name).pipe(
    iso({
      name,
      decode: (value) =>
        // SAFETY: slots holds every key of the layout, each within its declared width.
        Object.fromEntries(
          slots.map(({ key, size, shift }) => [key, Number(BigInt.asUintN(size, value >> shift))]),
        ) as Bits<Layout>,
      encode: (value: Bits<Layout>) => {
        const extra = Reflect.ownKeys(value).find((key) => !Object.hasOwn(layout, key))
        if (extra !== undefined) throw new RangeError(`unexpected field ${String(extra)}`)
        return slots.reduce((result, { key, size, shift, fits }) => {
          const field = value[key]
          if (!fits(field)) {
            throw new RangeError(`${key} must be an integer from 0 to ${2 ** size - 1}`)
          }
          return result | (BigInt(field) << shift)
        }, 0n)
      },
    }),
  )
  return withKeys(grammar, Object.keys(layout))
}

const asBytes = iso<string, Uint8Array>({
  name: "bytes",
  is: Predicate.isUint8Array,
  decode: toBytes,
  encode: toText,
})

export const bytes = (count: Ref<number> | number): Grammar<Uint8Array> =>
  takeBytes(count).pipe(asBytes)

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
      return Result.succeed(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value),
      )
    } catch {
      return Result.fail({ message: "valid UTF-8" })
    }
  },
  encode: (value) =>
    value.isWellFormed()
      ? Result.succeed(new TextEncoder().encode(value))
      : Result.fail({ message: "expected a string without lone surrogates" }),
})

export const parse = <A>(grammar: Grammar<A>, input: Uint8Array): Result.Result<A, ParseError> =>
  Result.mapError(
    parseText(grammar, toText(input)),
    ({ pos, expected, found }) =>
      new ParseError({ offset: pos, expected, found: found?.charCodeAt(0) }),
  )

const printBytes =
  (printer: typeof printUnknown) =>
  (grammar: GrammarInternal, value: Value): Result.Result<Uint8Array, PrintError> =>
    Result.flatMap(printer(grammar, value), (binary) =>
      nonByte.test(binary)
        ? Result.fail(
            new PrintError({
              issue: { _tag: "InvalidValue", expected: "only bytes to be printed", actual: value },
            }),
          )
        : Result.succeed(toBytes(binary)),
    )

const printUnchecked = printBytes(printUnknown)
const printVerified = printBytes(printCheckedUnknown)

export const print: <A>(grammar: Grammar<A>, value: A) => Result.Result<Uint8Array, PrintError> =
  printUnchecked

export const printChecked: typeof print = printVerified

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) => {
  const printer = options?.roundTrip === "off" ? printUnchecked : printVerified
  return codecFrom(
    Schema.Uint8Array,
    target,
    grammar,
    options?.identifier,
    (input) => parse(grammar, input),
    (value) => printer(grammar, value),
  )
}
