import { Console, Effect, Schema } from "effect"

import { char, digit, endOfInput, many, parse, ParseError } from "../src/parser.ts"

class OutOfRange extends Schema.TaggedErrorClass<OutOfRange>()("OutOfRange", {
  n: Schema.Finite,
}) {}

const byte = Effect.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 })
  const n = Number(digits.join(""))
  if (n > 255) return yield* new OutOfRange({ n })
  return n
})

const ip = Effect.gen(function* () {
  const a = yield* byte
  yield* char(".")
  const b = yield* byte
  yield* char(".")
  const c = yield* byte
  yield* char(".")
  const d = yield* byte
  yield* endOfInput
  return [a, b, c, d] as const
})

for (const source of ["192.168.1.1", "10.0.300.7", "192.168.1", "not-an-ip"]) {
  const r = Effect.runSync(parse(source, ip))
  if (r._tag === "Success") {
    Effect.runSync(Console.log(`${source}  →  parsed: ${r.success.join(".")}`))
  } else if (Schema.is(ParseError)(r.failure)) {
    Effect.runSync(Console.log(`${source}  →  ${r.failure.message}`))
  } else if (Schema.is(OutOfRange)(r.failure)) {
    Effect.runSync(Console.log(`${source}  →  out of range: ${r.failure.n} (0-255)`))
  }
}
