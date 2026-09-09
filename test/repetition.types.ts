import { expectTypeOf } from "vitest"

import * as B from "../src/binary.ts"
import * as G from "../src/index.ts"

const pair = G.repeat(G.integer, 2)
expectTypeOf<G.Type<typeof pair>>().toEqualTypeOf<readonly [number, number]>()
const pipedPair = G.integer.pipe(G.repeat(2))
expectTypeOf<G.Type<typeof pipedPair>>().toEqualTypeOf<readonly [number, number]>()
// @ts-expect-error exact repetitions require the complete tuple
G.print(pair, [1])
// @ts-expect-error exact repetitions reject excess elements
G.print(pair, [1, 2, 3])
declare const pairValue: G.Type<typeof pair>
// @ts-expect-error repetition values remain readonly
const mutablePair: [number, number] = pairValue
void mutablePair

const empty = G.repeat(G.integer, 0)
expectTypeOf<G.Type<typeof empty>>().toEqualTypeOf<readonly []>()
const maximumTuple = G.repeat(G.integer, 64)
expectTypeOf<G.Type<typeof maximumTuple>["length"]>().toEqualTypeOf<64>()
const large = G.repeat(G.integer, 65)
expectTypeOf<G.Type<typeof large>>().toEqualTypeOf<ReadonlyArray<number>>()
const invalid = G.repeat(G.integer, 1.5)
expectTypeOf<G.Type<typeof invalid>>().toEqualTypeOf<ReadonlyArray<number>>()

const many = G.many(G.integer)
expectTypeOf<G.Type<typeof many>>().toEqualTypeOf<ReadonlyArray<number>>()
const nonempty = G.many(G.integer, { min: 1 })
expectTypeOf<G.Type<typeof nonempty>>().toEqualTypeOf<readonly [number, ...Array<number>]>()
const pipedNonempty = G.integer.pipe(G.many({ min: 2 }))
expectTypeOf<G.Type<typeof pipedNonempty>>().toEqualTypeOf<readonly [number, ...Array<number>]>()
// @ts-expect-error a positive minimum rejects empty printer inputs
G.print(nonempty, [])

const exactMany = G.many(G.integer, { min: 2, max: 2 })
expectTypeOf<G.Type<typeof exactMany>>().toEqualTypeOf<readonly [number, number]>()
const pipedExactMany = G.integer.pipe(G.many({ min: 2, max: 2 }))
expectTypeOf<G.Type<typeof pipedExactMany>>().toEqualTypeOf<readonly [number, number]>()
const noItems = G.many(G.integer, { max: 0 })
expectTypeOf<G.Type<typeof noItems>>().toEqualTypeOf<readonly []>()

const separated = G.sepBy(G.integer, ",", { min: 1 })
expectTypeOf<G.Type<typeof separated>>().toEqualTypeOf<readonly [number, ...Array<number>]>()
const exactSeparated = G.sepBy(G.integer, ",", { min: 2, max: 2 })
expectTypeOf<G.Type<typeof exactSeparated>>().toEqualTypeOf<readonly [number, number]>()
const pipedSeparated = G.integer.pipe(G.sepBy(",", { min: 2, max: 2 }))
expectTypeOf<G.Type<typeof pipedSeparated>>().toEqualTypeOf<readonly [number, number]>()

declare const count: number
declare const eitherCount: 1 | 2
declare const possiblyZero: 0 | 1
declare const options: G.RepeatOptions
declare const optionalOptions: { readonly min: 1 } | undefined

const dynamic = G.repeat(G.integer, count)
expectTypeOf<G.Type<typeof dynamic>>().toEqualTypeOf<ReadonlyArray<number>>()
const explicitElement = G.repeat<number>(G.integer, 2)
expectTypeOf<G.Type<typeof explicitElement>>().toEqualTypeOf<ReadonlyArray<number>>()
const either = G.repeat(G.integer, eitherCount)
expectTypeOf<G.Type<typeof either>>().toEqualTypeOf<readonly [number] | readonly [number, number]>()
const dynamicBounds = G.many(G.integer, options)
expectTypeOf<G.Type<typeof dynamicBounds>>().toEqualTypeOf<ReadonlyArray<number>>()
const optionalBounds = G.many(G.integer, optionalOptions)
expectTypeOf<G.Type<typeof optionalBounds>>().toMatchTypeOf<ReadonlyArray<number>>()
G.print(optionalBounds, [])
const includesZero = G.many(G.integer, { min: possiblyZero })
expectTypeOf<G.Type<typeof includesZero>>().toEqualTypeOf<ReadonlyArray<number>>()
const independentBounds = G.many(G.integer, { min: eitherCount, max: eitherCount })
expectTypeOf<G.Type<typeof independentBounds>>().toEqualTypeOf<
  readonly [number, ...Array<number>]
>()

// Explicit option types cannot promise bounds without supplying them.
// @ts-expect-error an options argument is required with this overload
G.many<number, { min: 1 }>(G.integer)
// @ts-expect-error an options argument is required with this overload
G.sepBy<number, { min: 1 }>(G.integer, ",")

const binaryPair = G.repeat(B.byte, 2)
expectTypeOf<G.Type<typeof binaryPair>>().toEqualTypeOf<readonly [number, number]>()
const dependent = G.gen(function* () {
  const length = yield* B.byte
  const values = yield* G.repeat(B.byte, length)
  return { length, values }
})
expectTypeOf<G.Type<typeof dependent>["values"]>().toEqualTypeOf<ReadonlyArray<number>>()
const nested = G.gen(function* () {
  const values = yield* pair
  return { values }
})
expectTypeOf<G.Type<typeof nested>["values"]>().toEqualTypeOf<readonly [number, number]>()
