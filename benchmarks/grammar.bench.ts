import assert from "node:assert/strict"

import { Result } from "effect"
import { bench, describe } from "vitest"

import { type JsonValue, jsonValue } from "../examples/grammars/json.ts"
import * as Binary from "../src/binary.ts"
import * as Grammar from "../src/index.ts"

const timing = { time: 200, iterations: 10, warmupTime: 50, warmupIterations: 5 }

const buildNetstring = () =>
  Grammar.gen(function*() {
    const length = yield* Grammar.integer
    yield* Grammar.literal(":")
    const payload = yield* Grammar.take(length)
    yield* Grammar.literal(",")
    return { length, payload }
  })

const netstring = buildNetstring()
const countedList = Grammar.gen(function*() {
  const count = yield* Grammar.integer
  yield* Grammar.literal("/")
  const items = yield* Grammar.regex(/[a-z]/, "letter").pipe(Grammar.repeat(count))
  return { count, items }
})

const packet = Grammar.gen(function*() {
  yield* Binary.literal(0x45, 0x47)
  const sequence = yield* Binary.uint32
  const length = yield* Binary.uint16
  const payload = yield* Binary.bytes(length)
  return { sequence, length, payload }
})

const smallJson: JsonValue = {
  ok: true,
  items: [{ name: "first", score: 1.5, tags: ["a", "b"] }, { name: "second", score: 0, tags: null }],
}
const mediumJson: JsonValue = {
  ok: true,
  items: Array.from({ length: 120 }, (_, index) => ({
    name: `item-${index}`,
    active: index % 3 === 0,
    score: index * 0.25,
    tags: index % 2 === 0 ? [`a${index}`, `b${index}`] : null,
    meta: { depth: index, unit: "px" },
  })),
}

function textFixture<A>(name: string, grammar: Grammar.Grammar<A>, input: string, value: A) {
  assert.deepEqual(Result.getOrThrow(Grammar.parse(grammar, input)), value)
  for (const print of [Grammar.print, Grammar.printUnchecked]) {
    const output = Result.getOrThrow(print(grammar, value))
    assert.equal(output, input)
    assert.deepEqual(Result.getOrThrow(Grammar.parse(grammar, output)), value)
  }
  return {
    name: `${name} (${Buffer.byteLength(input)} bytes)`,
    parse: () => Grammar.parse(grammar, input),
    print: () => Grammar.print(grammar, value),
    printUnchecked: () => Grammar.printUnchecked(grammar, value),
  }
}

const textFixtures = [
  textFixture("small JSON", jsonValue, JSON.stringify(smallJson), smallJson),
  textFixture("medium JSON", jsonValue, JSON.stringify(mediumJson), mediumJson),
  textFixture("netstring", netstring, "12:hello world!,", { length: 12, payload: "hello world!" }),
  textFixture("counted list", countedList, "26/abcdefghijklmnopqrstuvwxyz", {
    count: 26,
    items: Array.from("abcdefghijklmnopqrstuvwxyz"),
  }),
]

const packetValue = {
  sequence: 42,
  length: 1024,
  payload: Uint8Array.from({ length: 1024 }, (_, index) => index % 256),
}
const packetInput = Uint8Array.from([0x45, 0x47, 0, 0, 0, 42, 4, 0, ...packetValue.payload])
assert.deepEqual(Result.getOrThrow(Binary.parse(packet, packetInput)), packetValue)
for (const print of [Binary.print, Binary.printUnchecked]) {
  const output = Result.getOrThrow(print(packet, packetValue))
  assert.deepEqual(output, packetInput)
  assert.deepEqual(Result.getOrThrow(Binary.parse(packet, output)), packetValue)
}

const fixtures = [
  ...textFixtures,
  {
    name: `binary packet (${packetInput.length} bytes)`,
    parse: () => Binary.parse(packet, packetInput),
    print: () => Binary.print(packet, packetValue),
    printUnchecked: () => Binary.printUnchecked(packet, packetValue),
  },
]

describe("construction", () => {
  bench("dependent netstring grammar", () => {
    buildNetstring()
  }, timing)
})

for (const operation of ["parse", "print", "printUnchecked"] as const) {
  describe(operation, () => {
    for (const fixture of fixtures) {
      bench(fixture.name, () => {
        fixture[operation]()
      }, timing)
    }
  })
}
