import { type Result, type Schema } from "effect"

import { iso } from "./combinators.ts"
import { type Compiled, compileWith, validateWith } from "./compile.ts"
import {
  type Grammar,
  type GrammarInternal,
  make,
  type NumberLayout,
  type Ref,
  type Silent,
  silent,
} from "./core.ts"
import { isCount } from "./env.ts"
import type { BinaryParseError, PrintError } from "./errors.ts"
import { binaryFormat } from "./format.ts"
import { countOf } from "./gen.ts"
import { parseWith } from "./parse.ts"
import { printCheckedWith, printWith } from "./print.ts"
import { type CodecOptions, codecWith } from "./schema.ts"

export type { Grammar, Ref, Silent, Type } from "./core.ts"
export {
  BinaryParseError,
  BinaryParseError as ParseError,
  PrintError,
  type PrintIssue,
} from "./errors.ts"
export { auditFidelity } from "./compile.ts"
export { describe, render } from "./render.ts"
export type { CodecOptions } from "./schema.ts"
export type { Compiled } from "./compile.ts"

export { binaryFormat as format } from "./format.ts"

export const literal = (value: Uint8Array | ReadonlyArray<number>): Silent =>
  silent({ _tag: "ByteLiteral", value: Uint8Array.from(value) })

const number = <const S extends NumberLayout>(
  layout: S,
  littleEndian = false,
): Grammar<S extends { kind: "float" } ? number : S["width"] extends 8 ? bigint : number> =>
  make({ _tag: "Number", littleEndian, ...layout })

export const uint8: Grammar<number> = number({ kind: "uint", width: 1 })
export const int8: Grammar<number> = number({ kind: "int", width: 1 })
export const byte = uint8

/** Multi-byte numbers in one byte order; see {@link be} and {@link le}. */
export interface Numbers {
  readonly uint16: Grammar<number>
  readonly uint32: Grammar<number>
  readonly uint64: Grammar<bigint>
  readonly int16: Grammar<number>
  readonly int32: Grammar<number>
  readonly int64: Grammar<bigint>
  readonly float32: Grammar<number>
  readonly float64: Grammar<number>
}

const numbers = (littleEndian: boolean): Numbers => ({
  uint16: number({ kind: "uint", width: 2 }, littleEndian),
  uint32: number({ kind: "uint", width: 4 }, littleEndian),
  uint64: number({ kind: "uint", width: 8 }, littleEndian),
  int16: number({ kind: "int", width: 2 }, littleEndian),
  int32: number({ kind: "int", width: 4 }, littleEndian),
  int64: number({ kind: "int", width: 8 }, littleEndian),
  float32: number({ kind: "float", width: 4 }, littleEndian),
  float64: number({ kind: "float", width: 8 }, littleEndian),
})

export const be: Numbers = numbers(false)
export const le: Numbers = numbers(true)

/** Unsigned LEB128, within the safe integer range. */
export const varuint: Grammar<number> = make({ _tag: "VarInt", signed: false })
/** Zigzag-encoded LEB128, within the safe integer range. */
export const varint: Grammar<number> = make({ _tag: "VarInt", signed: true })

export const bytes = (count: number | Ref<number>): Grammar<Uint8Array> =>
  make({ _tag: "Bytes", count: countOf(count, "bytes") })

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** Exactly `count` bytes of UTF-8. `count` is the byte length, not the character count. */
export const utf8 = (count: number | Ref<number>): Grammar<string> =>
  bytes(count).pipe(
    iso({
      decode: (value) => decoder.decode(value),
      encode: (value) => encoder.encode(value),
      name: "utf8",
    }),
  )

export type BitfieldValue<Fields extends Record<string, number>> = Readonly<
  Record<keyof Fields, number>
>

/**
 * Split an integer into named fields of the given bit widths, most significant
 * field first. Widths must sum to the integer's width for the value to be
 * fully described; higher bits than declared are rejected when parsing.
 */
export const bitfield = <const Fields extends Record<string, number>>(
  word: Grammar<number>,
  fields: Fields,
): Grammar<BitfieldValue<Fields>> => {
  const entries = Object.entries(fields)
  for (const [key, width] of entries) {
    if (!isCount(width) || width === 0) {
      throw new RangeError(`bitfield: ${key} must have a positive integer width`)
    }
  }
  const total = entries.reduce((sum, [, width]) => sum + width, 0)
  if (total > 53) throw new RangeError("bitfield: widths must sum to at most 53")
  const isComplete = (value: Record<string, number>): value is BitfieldValue<Fields> =>
    entries.every(([key]) => key in value)
  return word.pipe(
    iso({
      decode: (value) => {
        if (!isCount(value)) {
          throw new RangeError("bitfield: word must be a non-negative safe integer")
        }
        if (value >= 2 ** total) {
          throw new RangeError(`bitfield: ${value} has bits beyond the declared fields`)
        }
        const result: Record<string, number> = {}
        let rest = value
        for (const [key, width] of entries.toReversed()) {
          result[key] = rest % 2 ** width
          rest = Math.floor(rest / 2 ** width)
        }
        if (!isComplete(result)) throw new Error("bitfield: a field was not split")
        return result
      },
      encode: (value) => {
        let packed = 0
        for (const [key, width] of entries) {
          const field = value[key]
          if (!isCount(field) || field >= 2 ** width) {
            throw new RangeError(`bitfield: ${key} must be an integer in 0..${2 ** width - 1}`)
          }
          packed = packed * 2 ** width + field
        }
        return packed
      },
      name: "bitfield",
    }),
  )
}

export const parse = <A>(
  grammar: Grammar<A>,
  input: Uint8Array,
): Result.Result<A, BinaryParseError> => parseWith(grammar, input, binaryFormat)

export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<Uint8Array, PrintError> =>
  printWith(grammar, value, binaryFormat)

export const printChecked = <A>(
  grammar: Grammar<A>,
  value: A,
): Result.Result<Uint8Array, PrintError> => printCheckedWith(grammar, value, binaryFormat)

export const validate = (grammar: GrammarInternal) => validateWith(grammar, "binary")

export const compile = <A>(grammar: Grammar<A>): Compiled<A, Uint8Array, BinaryParseError> =>
  compileWith(grammar, binaryFormat)

export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) => codecWith(grammar, target, binaryFormat, options)
