import { Effect, Predicate, Result, Schema, SchemaIssue, SchemaTransformation } from "effect"

import { iso, namedLiteral, partialIso, sized, takeBytes } from "./combinators.ts"
import type { Grammar, GrammarInternal, Ref, Silent, Value } from "./core.ts"
import { isByteString } from "./env.ts"
import { PrintError } from "./errors.ts"
import { parse as parseText } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"
import { render } from "./render.ts"
import { type CodecOptions, printIssueToSchema } from "./schema.ts"

const hex = (byte: number): string => `0x${byte.toString(16).padStart(2, "0")}`

export class ParseError extends Schema.TaggedError<ParseError>()("BinaryParseError", {
  offset: Schema.Finite,
  expected: Schema.Array(Schema.String),
  found: Schema.UndefinedOr(Schema.Finite),
}) {
  override get message(): string {
    const found = this.found === undefined ? "end of input" : hex(this.found)
    const expected =
      this.expected.length === 1 ? this.expected[0] : `one of ${this.expected.join(", ")}`
    return `byte ${this.offset}: expected ${expected}, found ${found}`
  }
}

const chunk = 8192

const toText = (bytes: Uint8Array): string => {
  let result = ""
  for (let start = 0; start < bytes.length; start += chunk) {
    result += String.fromCharCode(...bytes.subarray(start, start + chunk))
  }
  return result
}

const toBytes = (binary: string): Uint8Array => {
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const uint = (size: number, name: string, littleEndian: boolean): Grammar<number> =>
  takeBytes(size, name).pipe(
    iso({
      name,
      is: (value) => Number.isSafeInteger(value) && value >= 0 && value < 256 ** size,
      decode: (binary) => {
        let value = 0
        for (let index = 0; index < size; index++) {
          value = value * 256 + binary.charCodeAt(littleEndian ? size - 1 - index : index)
        }
        return value
      },
      encode: (value) => {
        let binary = ""
        for (let index = 0; index < size; index++) {
          const place = littleEndian ? index : size - 1 - index
          binary += String.fromCharCode(Math.floor(value / 256 ** place) % 256)
        }
        return binary
      },
    }),
  )

export const uint8 = uint(1, "uint8", false)
export const uint16 = uint(2, "uint16", false)
export const uint32 = uint(4, "uint32", false)
export const uint16le = uint(2, "uint16le", true)
export const uint32le = uint(4, "uint32le", true)

export type BitLayout = Readonly<Record<string, number>>

export type Bits<Layout extends BitLayout> = {
  readonly [K in keyof Layout]: Layout[K] extends 1 ? 0 | 1 : number
}

export const bits = <const Layout extends BitLayout>(layout: Layout): Grammar<Bits<Layout>> => {
  const fields = Object.entries(layout)
  for (const [key, size] of fields) {
    if (/^\d+$/.test(key)) {
      throw new RangeError(
        `bits: field ${JSON.stringify(key)} is an integer key, which JavaScript reorders`,
      )
    }
    if (!Number.isInteger(size) || size < 1 || size > 53) {
      throw new RangeError(`bits: field ${JSON.stringify(key)} must be 1 to 53 bits wide`)
    }
  }
  const width = fields.reduce((total, [, size]) => total + size, 0)
  if (width === 0 || width % 8 !== 0) {
    throw new RangeError(
      `bits: the layout is ${width} bits wide, which is not a whole number of bytes`,
    )
  }

  let remaining = width
  const slots = fields.map(([key, size]) => {
    remaining -= size
    return { key, size, shift: BigInt(remaining) }
  })

  const name = fields.map(([key, size]) => `${key}:${size}`).join(" ")

  return takeBytes(width / 8, name).pipe(
    iso({
      name,
      keys: slots.map((slot) => slot.key),
      decode: (binary) => {
        let word = 0n
        for (let index = 0; index < binary.length; index++) {
          word = (word << 8n) | BigInt(binary.charCodeAt(index))
        }
        // SAFETY: slots holds every key of the layout, each within its declared width.
        return Object.fromEntries(
          slots.map(({ key, size, shift }) => [key, Number(BigInt.asUintN(size, word >> shift))]),
        ) as Bits<Layout>
      },
      encode: (value: Bits<Layout>) => {
        let word = 0n
        for (const { key, size, shift } of slots) {
          const field = value[key]
          if (
            field === undefined ||
            !Number.isSafeInteger(field) ||
            field < 0 ||
            field >= 2 ** size
          ) {
            throw new RangeError(`${key} must be an integer from 0 to ${2 ** size - 1}`)
          }
          word |= BigInt(field) << shift
        }
        let binary = ""
        for (let place = width - 8; place >= 0; place -= 8) {
          binary += String.fromCharCode(Number(BigInt.asUintN(8, word >> BigInt(place))))
        }
        return binary
      },
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
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`literal: ${value} is not a byte`)
    }
  }
  return namedLiteral(String.fromCharCode(...values), values.map(hex).join(" "))
}

export const ascii = partialIso<Uint8Array, string>({
  name: "ascii",
  decode: (value) =>
    value.every((byte) => byte <= 0x7f)
      ? Result.succeed(toText(value))
      : Result.fail({ message: "ASCII bytes" }),
  encode: (value) =>
    /^[\0-\x7f]*$/.test(value)
      ? Result.succeed(toBytes(value))
      : Result.fail({ message: "expected only ASCII characters" }),
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
    (error) =>
      new ParseError({
        offset: error.pos,
        expected: error.expected,
        found: error.found?.charCodeAt(0),
      }),
  )

const printBytes = (
  grammar: GrammarInternal,
  value: Value,
  checked: boolean,
): Result.Result<Uint8Array, PrintError> =>
  Result.flatMap(
    checked ? printCheckedUnknown(grammar, value) : printUnknown(grammar, value),
    (binary) =>
      isByteString(binary)
        ? Result.succeed(toBytes(binary))
        : Result.fail(
            new PrintError({
              issue: {
                _tag: "InvalidValue",
                expected: "printed bytes",
                actual: value,
                detail: "the grammar printed a character above 0xff",
              },
            }),
          ),
  )

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<Uint8Array, PrintError> =>
  printBytes(grammar, value, false)

export const printChecked = <A>(
  grammar: Grammar<A>,
  value: A,
): Result.Result<Uint8Array, PrintError> => printBytes(grammar, value, true)

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
