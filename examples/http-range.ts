import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import * as Grammar from "../src/index.ts"

const Natural = Schema.Natural
const ClosedRange = Schema.Struct({
  kind: Schema.Literal("closed"),
  start: Natural,
  end: Natural,
}).check(
  Schema.makeFilter((range) => range.start <= range.end, {
    message: "the range start must not exceed the range end",
  }),
)
const OpenRange = Schema.Struct({
  kind: Schema.Literal("open"),
  start: Natural,
})
const SuffixRange = Schema.Struct({
  kind: Schema.Literal("suffix"),
  length: Schema.Int.check(Schema.isGreaterThan(0)),
})

export const ByteRanges = Schema.Array(Schema.Union([ClosedRange, OpenRange, SuffixRange])).check(
  Schema.isMinLength(1),
)

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
          Effect.fail(
            new SchemaIssue.InvalidValue({ message: "expected byte ranges" }, source, options),
          )
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

const tag = <const Tag extends string>(value: Tag) => Grammar.empty.pipe(Grammar.as(value))

const closed = Grammar.gen(function* () {
  const kind = yield* tag("closed")
  const start = yield* Grammar.integer
  yield* Grammar.literal("-")
  const end = yield* Grammar.integer
  return { kind, start, end }
})

const open = Grammar.gen(function* () {
  const kind = yield* tag("open")
  const start = yield* Grammar.integer
  yield* Grammar.literal("-")
  return { kind, start }
})

const suffix = Grammar.gen(function* () {
  const kind = yield* tag("suffix")
  yield* Grammar.literal("-")
  const length = yield* Grammar.integer
  return { kind, length }
})

export const ByteRangeCodec = Grammar.codec(
  Grammar.prefix(
    "bytes=",
    Grammar.sepBy(Grammar.choiceOn("kind", { closed, open, suffix }), ",", { min: 1 }),
  ),
  ByteRanges,
  { identifier: "ByteRanges" },
)
