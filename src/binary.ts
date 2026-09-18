import { Effect, Predicate, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import { iso, namedLiteral, sized, takeBytes } from "./combinators.ts"
import type { Grammar, GrammarInternal, Ref, Silent, Value } from "./core.ts"
import { isByteString } from "./env.ts"
import { PrintError } from "./errors.ts"
import { parse as parseText } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"
import { render } from "./render.ts"
import { type CodecOptions, printIssueToSchema } from "./schema.ts"

export const hex = (bytes: Iterable<number>): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")

export const Bit = Schema.Literals([0, 1])
export const Uint = (size: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** size - 1 }))
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
    const found = this.found === undefined ? "end of input" : `0x${hex([this.found])}`
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
  const slots = fields.map(([key, size]) => ({ key, size, shift: (shift -= BigInt(size)) }))

  return word(width / 8, name).pipe(
    iso({
      name,
      keys: Object.keys(layout),
      decode: (value) =>
        // SAFETY: slots holds every key of the layout, each within its declared width.
        Object.fromEntries(
          slots.map(({ key, size, shift }) => [key, Number(BigInt.asUintN(size, value >> shift))]),
        ) as Bits<Layout>,
      encode: (value: Bits<Layout>) =>
        slots.reduce((result, { key, size, shift }) => {
          const field = value[key]
          if (!Schema.is(Uint(size))(field)) {
            throw new RangeError(`${key} must be an integer from 0 to ${2 ** size - 1}`)
          }
          return result | (BigInt(field) << shift)
        }, 0n),
    }),
  )
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
  sized(length, takeBytes).pipe(asBytes)

export const literal = (...values: ReadonlyArray<number>): Silent => {
  if (values.some((value) => !Schema.is(Uint8)(value))) {
    throw new RangeError(`literal: expected bytes, got ${values.join(", ")}`)
  }
  return namedLiteral(
    toText(Uint8Array.from(values)),
    values.map((value) => `0x${hex([value])}`).join(" "),
  )
}

export const ascii = iso<Uint8Array, string>({
  name: "ascii",
  is: (value) => /^[\0-\x7f]*$/.test(value),
  decode: toText,
  encode: toBytes,
})

export const utf8 = iso<Uint8Array, string>({
  name: "utf8",
  is: (value) => value.isWellFormed(),
  decode: (value) => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value)
    } catch {
      throw new TypeError("valid UTF-8")
    }
  },
  encode: (value) => new TextEncoder().encode(value),
})

export const parse = <A>(grammar: Grammar<A>, input: Uint8Array): Result.Result<A, ParseError> =>
  Result.mapError(
    parseText(grammar, toText(input)),
    ({ pos, expected, found }) =>
      new ParseError({ offset: pos, expected, found: found?.charCodeAt(0) }),
  )

const printBytes = (
  grammar: GrammarInternal,
  value: Value,
  checked: boolean,
): Result.Result<Uint8Array, PrintError> =>
  Result.flatMap((checked ? printCheckedUnknown : printUnknown)(grammar, value), (binary) =>
    isByteString(binary)
      ? Result.succeed(toBytes(binary))
      : Result.fail(
          new PrintError({
            issue: { _tag: "InvalidValue", expected: "only bytes to be printed", actual: value },
          }),
        ),
  )

export const print = <A>(grammar: Grammar<A>, value: A) => printBytes(grammar, value, false)

export const printChecked = <A>(grammar: Grammar<A>, value: A) => printBytes(grammar, value, true)

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<S["Encoded"], Uint8Array>({
        decode: (input) =>
          Effect.fromResult(parse(grammar, input)).pipe(
            Effect.mapError(({ message }) => new SchemaIssue.InvalidValue({ message }, input)),
          ),
        encode: (value) =>
          Effect.fromResult(printBytes(grammar, value, options?.roundTrip !== "off")).pipe(
            Effect.mapError((error) => printIssueToSchema(value, error.issue)),
          ),
      }),
    ),
    Schema.annotate({ identifier: options?.identifier, description: render(grammar) }),
  )
