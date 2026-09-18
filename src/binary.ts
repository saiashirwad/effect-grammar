import { Predicate, Result, Schema } from "effect"

import { type CodecOptions, codecFrom } from "./codec.ts"
import { iso, partialIso, prefixedBy, takeBytes, withKeys } from "./combinators.ts"
import {
  type Grammar,
  type GrammarInternal,
  type Ref,
  type Silent,
  silent,
  type Value,
} from "./core.ts"
import { nonByte } from "./env.ts"
import { PrintError } from "./errors.ts"
import { parse as parseText } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")

export const Bit = Schema.Literals([0, 1])
export const Uint = (size: number) => {
  if (!Number.isInteger(size) || size < 1 || size > 53) {
    throw new RangeError(`Uint: expected a width of 1 to 53 bits, got ${size}`)
  }
  return Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** size - 1 }))
}
export const Uint8 = Uint(8)
export const Uint16 = Uint(16)
export const Uint32 = Uint(32)

export class ParseError extends Schema.TaggedError<ParseError>()("BinaryParseError", {
  offset: Schema.Finite,
  expected: Schema.Array(Schema.String),
  found: Schema.UndefinedOr(Schema.Finite),
}) {
  override get message(): string {
    const expected =
      this.expected.length === 1 ? this.expected[0] : `one of ${this.expected.join(", ")}`
    const found = this.found === undefined ? "end of input" : `0x${hex(Uint8Array.of(this.found))}`
    return `byte ${this.offset}: expected ${expected}, found ${found}`
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

export const uint8 = uint(1, "uint8")
export const uint16 = uint(2, "uint16")
export const uint32 = uint(4, "uint32")
export const uint16le = uint(2, "uint16le", true)
export const uint32le = uint(4, "uint32le", true)

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
  is: (value) => /^[\0-\x7f]*$/.test(value),
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
