import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

const offset = Grammar.integer.pipe(Grammar.filter((value: number) => value >= 0, "a non-negative byte offset"))

const closed = Grammar.gen(function*() {
  const start = yield* offset
  yield* Grammar.literal("-")
  const end = yield* offset
  return { kind: "closed" as const, start, end }
}).pipe(
  Grammar.filter(
    (range: { start: number; end: number }) => range.start <= range.end,
    "a range whose start does not exceed its end",
  ),
)

const open = Grammar.gen(function*() {
  const start = yield* offset
  yield* Grammar.literal("-")
  return { kind: "open" as const, start }
})

const suffix = Grammar.gen(function*() {
  yield* Grammar.literal("-")
  const length = yield* Grammar.integer.pipe(Grammar.filter((value: number) => value > 0, "a positive suffix length"))
  return { kind: "suffix" as const, length }
})

export const ByteRangeCodec = GrammarSchema.codec(
  Grammar.dispatch(
    "kind",
    [
      ["closed", closed],
      ["open", open],
      ["suffix", suffix],
    ] as const,
  ).pipe(Grammar.sepBy(",", { min: 1 }), Grammar.prefix("bytes=")),
  { identifier: "ByteRanges" },
)

export const ByteRanges = Schema.toType(ByteRangeCodec)

export type ByteRangesValue = Schema.Schema.Type<typeof ByteRanges>
export type ByteRange = ByteRangesValue[number]

const parseRange = (text: string): ByteRange | undefined => {
  const match = /^(\d*)-(\d*)$/.exec(text)
  if (match === null) return undefined
  const [, start, end] = match
  if (start && end) return { kind: "closed", start: Number(start), end: Number(end) }
  if (start) return { kind: "open", start: Number(start) }
  if (end) return { kind: "suffix", length: Number(end) }
  return undefined
}

const printRange = (range: ByteRange): string => {
  switch (range.kind) {
    case "closed":
      return `${range.start}-${range.end}`
    case "open":
      return `${range.start}-`
    case "suffix":
      return `-${range.length}`
  }
}

export const ManualByteRangeCodec = Schema.String.pipe(
  Schema.decodeTo(
    ByteRanges,
    SchemaTransformation.transformOrFail<ByteRangesValue, string>({
      decode: (source, options) => {
        const invalid = () =>
          Effect.fail(new SchemaIssue.InvalidValue({ message: "expected byte ranges" }, source, options))
        if (!source.startsWith("bytes=")) return invalid()
        return Effect.forEach(source.slice("bytes=".length).split(","), (text) => {
          const range = parseRange(text)
          return range === undefined ? invalid() : Effect.succeed(range)
        })
      },
      encode: (ranges) => Effect.succeed(`bytes=${ranges.map(printRange).join(",")}`),
    }),
  ),
  Schema.annotate({ identifier: "ManualByteRanges" }),
)
