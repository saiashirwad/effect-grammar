import { Schema } from "effect"

import type { InputKind } from "./core.ts"
import { BinaryParseError, ParseError } from "./errors.ts"

export type Input = string | Uint8Array

export interface Format<I extends Input, E extends Error> {
  readonly kind: InputKind
  readonly error: (input: I, pos: number, expected: ReadonlyArray<string>) => E
  readonly join: (chunks: ReadonlyArray<I>) => I
  readonly schema: Schema.Codec<I, I>
}

export const textFormat: Format<string, ParseError> = {
  kind: "text",
  error: (input, pos, expected) => {
    const before = input.slice(0, pos)
    const code = input.codePointAt(pos)
    return new ParseError({
      pos,
      line: before.split("\n").length,
      column: before.length - before.lastIndexOf("\n"),
      expected,
      found: code === undefined ? undefined : String.fromCodePoint(code),
    })
  },
  join: (chunks) => chunks.join(""),
  schema: Schema.String,
}

export const binaryFormat: Format<Uint8Array, BinaryParseError> = {
  kind: "binary",
  error: (input, pos, expected) => new BinaryParseError({ pos, expected, found: input[pos] }),
  join: (chunks) => {
    const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  },
  schema: Schema.Uint8Array,
}
