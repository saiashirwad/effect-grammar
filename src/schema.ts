import { Schema } from "effect"

import { type CodecOptions, codecFrom } from "./codec.ts"
import type { Grammar } from "./core.ts"
import { parse } from "./parse.ts"
import { printCheckedUnknown, printUnknown } from "./print.ts"

export type { CodecOptions } from "./codec.ts"

// Decoding consumes the whole string. Encoding checks round trips unless
// `roundTrip: "off"` is set.
export const codec = <S extends Schema.Top, A extends S["Encoded"]>(
  grammar: Grammar<A>,
  target: S,
  options?: CodecOptions,
) => {
  const print = options?.roundTrip === "off" ? printUnknown : printCheckedUnknown
  return codecFrom(
    Schema.String,
    target,
    grammar,
    options?.identifier,
    (text) => parse(grammar, text),
    (value) => print(grammar, value),
  )
}
