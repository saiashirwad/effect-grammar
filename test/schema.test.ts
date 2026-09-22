import assert from "node:assert/strict"

import { describe, it } from "@effect/vitest"
import { Context, Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

import * as Binary from "../src/binary.ts"
import * as G from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"

class DecodePrefix extends Context.Service<DecodePrefix, string>()("test/DecodePrefix") {}
class EncodePrefix extends Context.Service<EncodePrefix, string>()("test/EncodePrefix") {}

describe("Schema integration", () => {
  it.effect("preserves target transformations and distinct decoding and encoding services", () =>
    Effect.gen(function* () {
      const target = Schema.Finite.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformOrFail({
            decode: (value: number) => Effect.map(DecodePrefix, (prefix) => `${prefix}${value}`),
            encode: (value: string) => Effect.map(EncodePrefix, (prefix) => Number(value.slice(prefix.length))),
          }),
        ),
      )
      const text = GrammarSchema.codec(G.integer, target)
      const binary = Binary.codec(Binary.uint8, target)

      assert.equal(yield* Schema.decodeEffect(text)("42").pipe(Effect.provideService(DecodePrefix, "text:")), "text:42")
      assert.equal(
        yield* Schema.encodeEffect(text)("value:42").pipe(Effect.provideService(EncodePrefix, "value:")),
        "42",
      )
      assert.equal(
        yield* Schema.decodeEffect(binary)(Uint8Array.of(42)).pipe(Effect.provideService(DecodePrefix, "byte:")),
        "byte:42",
      )
      assert.deepEqual(
        yield* Schema.encodeEffect(binary)("value:42").pipe(Effect.provideService(EncodePrefix, "value:")),
        Uint8Array.of(42),
      )
    }),
  )

  it.effect("keeps nested print paths as Schema pointers", () =>
    Effect.gen(function* () {
      const target = Schema.Struct({ values: Schema.Array(Schema.Finite) })
      const textGrammar = G.struct({ values: G.integer.pipe(G.repeat(1)) })
      const binaryGrammar = G.struct({ values: Binary.uint8.pipe(G.repeat(1)) })
      const text = GrammarSchema.codec(textGrammar, target, { identifier: "TextValues" })
      const binary = Binary.codec(binaryGrammar, target, { identifier: "ByteValues" })

      assert.equal(text.ast.annotations?.identifier, "TextValues")
      assert.equal(text.ast.annotations?.description, G.render(textGrammar))
      assert.equal(binary.ast.annotations?.identifier, "ByteValues")
      assert.equal(binary.ast.annotations?.description, G.render(binaryGrammar))

      const textError = yield* Effect.flip(Schema.encodeEffect(text)({ values: [1.5] }))
      const binaryError = yield* Effect.flip(Schema.encodeEffect(binary)({ values: [256] }))
      const format = SchemaIssue.makeFormatterStandardSchemaV1()
      assert.deepEqual(format(textError.issue).issues, [{ path: ["values", 0], message: "expected integer, got 1.5" }])
      assert.deepEqual(format(binaryError.issue).issues, [{ path: ["values", 0], message: "expected uint8, got 256" }])
    }),
  )

  it.effect("uses checked text encoding after the target schema encodes", () =>
    Effect.gen(function* () {
      const rounded = G.integer.pipe(G.transform({ decode: (value) => value, encode: Math.floor }))
      const codec = GrammarSchema.codec(rounded, Schema.Finite)
      const error = yield* Effect.flip(Schema.encodeEffect(codec)(1.5))
      assert.match(SchemaIssue.makeFormatterDefault()(error.issue), /reads back as 1/)
    }),
  )
})
