// This fixture is also compiled against the installed package declarations.
import { Result, Schema } from "effect"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"
import * as S from "../src/schema.ts"
import * as Testing from "../src/testing.ts"
import * as Text from "../src/text.ts"

const input = Uint8Array.of(1)

Text.parse(Text.integer, "1")
Text.codec(Text.integer, Schema.Finite)
B.parse(B.uint8, input)
B.print(B.uint8, 1)
B.codec(B.uint8, Schema.Finite)
// @ts-expect-error text terminals cannot run on bytes
B.parse(G.integer, input)
// @ts-expect-error text terminals cannot print bytes
B.print(G.integer, 1)
// @ts-expect-error unchecked printing still requires the byte domain
B.printUnchecked(G.integer, 1)
// @ts-expect-error byte terminals cannot run on text
G.parse(B.uint8, "1")
// @ts-expect-error byte terminals cannot print text
Text.print(B.uint8, 1)
// @ts-expect-error unchecked printing still requires the text domain
G.printUnchecked(B.uint8, 1)
// @ts-expect-error the text codec has a fixed domain
S.codec(B.uint8, Schema.Finite)
// @ts-expect-error the byte codec has a fixed domain
B.codec(Text.integer, Schema.Finite)
// @ts-expect-error the Text facade codec has a fixed domain
Text.codec(B.uint8, Schema.Finite)
// @ts-expect-error the default Grammar domain is text
const wrongAnnotation: G.Grammar<number> = B.uint8
// @ts-expect-error A remains invariant even for neutral grammars
const widened: G.NeutralGrammar<number> = G.empty.pipe(G.as(1))
void [wrongAnnotation, widened]

const neutral: G.NeutralGrammar<void> = G.empty
G.parse(neutral, "")
B.parse(neutral, input)
G.print(G.tuple(), [])
B.print(G.tuple(), [])
G.print(G.struct({}), {})
B.print(G.struct({}), {})
G.print(G.seq(), undefined)
B.print(G.seq(), undefined)
// oxlint-disable-next-line require-yield -- a yield-free grammar is deliberately neutral
const constant = G.gen(function* () {
  return { kind: "empty" } as const
})
const constantDomain: G.DomainOf<typeof constant> extends never ? true : false = true
void constantDomain
G.parse(constant, "")
B.parse(constant, input)
B.parse(G.choice([B.uint8, G.empty.pipe(G.as(0))]), input)
G.parse(G.choice([G.integer, G.empty.pipe(G.as(0))]), "1")
B.parse(B.uint8.pipe(G.prefix(G.empty), G.suffix(G.empty)), input)
B.parse(B.uint8.pipe(G.between(B.literal(1), B.literal(2))), input)

const bytesGen = G.gen(function* () {
  yield* B.literal(1)
  const size = yield* B.uint8
  const body = yield* B.bytes(size)
  return { size, body }
})
B.parse(bytesGen, input)
// @ts-expect-error gen preserves the domain of every yield
G.parse(bytesGen, "")
const mixedGen = G.gen(function* () {
  yield* G.literal("")
  return yield* B.uint8
})
// @ts-expect-error even a discarded text yield imposes text domain
B.parse(mixedGen, input)
// @ts-expect-error the byte yield also remains in the domain
G.parse(mixedGen, "")

const nested = G.struct({ values: G.tuple(B.uint8, G.struct({ word: B.uint16 })) })
B.parse(nested, input)
// @ts-expect-error nested products preserve byte domain
G.parse(nested, "")
const mixedProduct = G.struct({ values: G.tuple(B.uint8, G.struct({ word: G.integer })) })
// @ts-expect-error nested mixed products cannot run as bytes
B.parse(mixedProduct, input)
// @ts-expect-error nested mixed products cannot run as text
G.parse(mixedProduct, "")

const mixedChoice = G.choice([B.uint8, G.integer], { print: "roundTrip" })
// @ts-expect-error contextual runner inference cannot erase a mixed branch domain
B.parse(G.choice([B.uint8, G.integer]), input)
// @ts-expect-error contextual codec inference cannot erase a mixed branch domain
S.codec(G.choice([G.integer, B.uint8]), Schema.Finite)
// @ts-expect-error choice cannot widen its domain into a byte runner
B.parse(mixedChoice, input)
// @ts-expect-error choice cannot widen its domain into a text runner
G.parse(mixedChoice, "")
// @ts-expect-error mixed codec input is rejected too
B.codec(mixedChoice, Schema.Finite)
// @ts-expect-error mixed codec input is rejected too
S.codec(mixedChoice, Schema.Finite)

const binaryChoice = G.taggedChoice("kind", [
  ["byte", B.uint8],
  ["word", B.uint16],
])
B.parse(binaryChoice, input)
const mixedTagged = G.taggedChoice("kind", [
  ["byte", B.uint8],
  ["text", G.integer],
])
// @ts-expect-error taggedChoice preserves all branch domains
B.parse(mixedTagged, input)
const binaryDispatch = G.dispatch("kind", [["byte", G.struct({ kind: B.literal(1).pipe(G.as("byte")), n: B.uint8 })]])
B.parse(binaryDispatch, input)
const mixedDispatch = G.dispatch("kind", [
  ["byte", G.struct({ kind: B.literal(1).pipe(G.as("byte")), n: B.uint8 })],
  ["text", G.struct({ kind: G.literal("t").pipe(G.as("text")), n: G.integer })],
])
// @ts-expect-error dispatch preserves all branch domains
B.parse(mixedDispatch, input)

const matched = G.gen(function* () {
  const kind = yield* B.uint8.pipe(G.filter((n): n is 1 | 2 => n === 1 || n === 2, "kind"))
  const value = yield* G.match(kind, [
    [1, B.uint8],
    [2, B.uint16],
  ])
  return { kind, value }
})
B.parse(matched, input)
const mixedMatch = G.gen(function* () {
  const kind = yield* B.literal(1).pipe(G.as(1))
  const value = yield* G.match(kind, [[1, G.integer]])
  return { kind, value }
})
// @ts-expect-error match branches contribute their domain to gen
B.parse(mixedMatch, input)

B.parse(B.uint8.pipe(G.sepBy(B.literal(0))), input)
// @ts-expect-error string separators impose text domain
B.parse(B.uint8.pipe(G.sepBy(",")), input)
// @ts-expect-error mixed separators are also unexecutable as text
G.parse(B.uint8.pipe(G.sepBy(",")), "")
// @ts-expect-error empty string delimiters are text, use G.empty for neutrality
B.parse(B.uint8.pipe(G.prefix("")), input)
// @ts-expect-error suffix preserves the delimiter domain
B.parse(B.uint8.pipe(G.suffix("!")), input)
// @ts-expect-error between preserves both delimiter domains
B.parse(B.uint8.pipe(G.between(B.literal(1), ")")), input)
// @ts-expect-error sequence includes every part's domain
B.parse(G.seq(B.literal(1), G.literal("x")), input)

const refined: B.Grammar<1 | 2> = B.uint8.pipe(G.filter((n): n is 1 | 2 => n === 1 || n === 2, "one or two"))
const filtered: B.Grammar<1 | 2> = refined.pipe(G.filter((n: number) => n > 0, "positive"))
const transformed: B.Grammar<string> = filtered.pipe(G.transform({ decode: String, encode: (): 1 | 2 => 1 }))
const fallible: B.Grammar<string> = transformed.pipe(
  G.transformOrFail({ decode: Result.succeed, encode: Result.succeed }),
)
B.parse(fallible.pipe(G.label("value"), G.skip("1")), input)
B.parse(B.uint8.pipe(G.many(), G.optional), input)
B.parse(B.uint8.pipe(G.repeat(2)), input)
B.parse(B.uint8.pipe(G.optional, G.defaulted(0)), input)
B.parse(G.flag(B.literal(1)), input)
// @ts-expect-error filters cannot erase the byte domain
G.parse(filtered, "")
// @ts-expect-error transformations cannot erase mixed domains
B.parse(mixedChoice.pipe(G.transform({ decode: String, encode: Number })), input)
// @ts-expect-error repetitions cannot erase mixed domains
B.parse(mixedChoice.pipe(G.many()), input)
// @ts-expect-error optional cannot erase mixed domains
B.parse(G.optional(mixedChoice), input)
// @ts-expect-error skip cannot erase mixed domains
B.parse(mixedChoice.pipe(G.skip(0)), input)
B.parse(
  // @ts-expect-error suspend cannot erase mixed domains
  G.suspend(() => mixedChoice),
  input,
)

type Tree = { readonly value: number; readonly children: ReadonlyArray<Tree> }
const tree: B.Grammar<Tree> = G.suspend(() =>
  G.struct({ value: B.uint8, children: tree.pipe(G.countPrefixed(B.uint8)) }),
)
B.parse(tree, input)
const textTree: G.Grammar<Tree> = G.suspend(() =>
  G.struct({ value: G.integer, children: textTree.pipe(G.countPrefixed(G.integer)) }),
)
G.parse(textTree, "")
// @ts-expect-error recursive byte annotations remain byte-only
G.parse(tree, "")
// @ts-expect-error count prefix and item must agree at the runner
B.parse(B.uint8.pipe(G.countPrefixed(G.integer)), input)
// @ts-expect-error text length prefix rejects byte terminals
G.lengthPrefixed(B.uint8)
// @ts-expect-error binary length prefix rejects text terminals
B.lengthPrefixed(G.integer)
// @ts-expect-error UTF-8 changes the value type, not the input/output domain
G.parse(B.utf8(B.bytes(1)), "x")

Testing.Binary.assertPrintParse(B.uint8, 1)
Testing.assertPrintParse(G.integer, 1)
// @ts-expect-error byte law helpers require byte grammars
Testing.Binary.assertPrintParse(G.integer, 1)
// @ts-expect-error text law helpers require text grammars
Testing.assertPrintParse(B.uint8, 1)
