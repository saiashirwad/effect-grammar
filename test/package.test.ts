import { NodeServices } from "@effect/platform-node"
import { assert, describe, layer } from "@effect/vitest"
import { Context, Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

import * as index from "../src/index.ts"

class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly exitCode: number
  readonly output: string
}> {}

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, args, { cwd })
    const [output, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], {
      concurrency: 2,
    })
    if (exitCode !== 0) return yield* new CommandFailed({ command, exitCode, output })
    return output
  }).pipe(Effect.scoped)

class Packed extends Context.Service<
  Packed,
  { readonly root: string; readonly workspace: string; readonly tarball: string }
>()("test/Packed") {
  static readonly layer = Layer.effect(
    Packed,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
      const workspace = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "effect-grammar-pack-" }))
      yield* run("pnpm", ["build"], root)
      yield* run("pnpm", ["pack", "--pack-destination", workspace], root)
      const packed = (yield* fs.readDirectory(workspace)).find((name) => name.endsWith(".tgz"))
      assert.isDefined(packed, "pnpm pack produced no tarball")
      return { root, workspace, tarball: path.join(workspace, packed) }
    }),
  )
}

describe("packaged exports", () => {
  layer(Packed.layer.pipe(Layer.provideMerge(NodeServices.layer)), { timeout: "2 minutes" })((it) => {
    it.effect("ships JavaScript and declarations for every source module, including internals", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { root, workspace, tarball } = yield* Packed
        const entries = (yield* run("tar", ["-tzf", tarball], workspace)).split("\n")
        const sources = (yield* fs.readDirectory(path.join(root, "src"), { recursive: true }))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => name.slice(0, -3))
          .sort()
        assert.ok(sources.includes("internal/bytes"))
        assert.ok(sources.includes("internal/schema"))
        for (const extension of [".js", ".d.ts"]) {
          const shipped = entries
            .filter((entry) => entry.startsWith("package/dist/") && entry.endsWith(extension))
            .map((entry) => entry.slice("package/dist/".length, -extension.length))
            .sort()
          assert.deepStrictEqual(shipped, sources)
        }
      }),
    )

    it.effect("imports every declared export and hides undeclared files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { root, workspace, tarball } = yield* Packed
        const consumer = path.join(workspace, "consumer")
        const modules = path.join(consumer, "node_modules")
        yield* fs.makeDirectory(modules, { recursive: true })
        yield* run("tar", ["-xzf", tarball], consumer)
        yield* fs.symlink(path.join(consumer, "package"), path.join(modules, "effect-grammar"))
        yield* fs.symlink(path.join(root, "node_modules", "effect"), path.join(modules, "effect"))

        const expected = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
          Object.keys(index).sort(),
        )
        const script = [
          "const root = await import('effect-grammar')",
          "const binary = await import('effect-grammar/Binary')",
          "const textFacade = await import('effect-grammar/Text')",
          "const adapter = await import('effect-grammar/Schema')",
          "const testing = await import('effect-grammar/testing')",
          "const { Schema } = await import('effect')",
          `const expected = ${expected}`,
          "const actual = Object.keys(root).sort()",
          "if (JSON.stringify(actual) !== JSON.stringify(expected)) {",
          "  throw new Error('root exports differ: ' + JSON.stringify({ expected, actual }))",
          "}",
          "if (typeof binary.bits !== 'function') throw new Error('missing Binary.bits')",
          "if (textFacade.parse !== root.parse || textFacade.codec !== adapter.codec) throw new Error('Text facade')",
          "if (typeof testing.Binary.assertParsePrintCanonical !== 'function') throw new Error('byte law helpers')",
          "if ('codec' in root || 'decodeTo' in root) throw new Error('obsolete root export')",
          "if ('takeBytes' in binary || 'takeByteString' in binary) throw new Error('raw byte-string export')",
          "const text = adapter.codec(root.integer, Schema.Number)",
          "if (Schema.decodeSync(text)('42') !== 42 || Schema.encodeSync(text)(42) !== '42') throw new Error('text codec')",
          "const bytes = binary.codec(binary.bytes(2), Schema.Uint8Array)",
          "const value = Schema.decodeSync(bytes)(Uint8Array.of(0, 255))",
          "if (binary.hex(Schema.encodeSync(bytes)(value)) !== '00 ff') throw new Error('binary codec')",
          "if (typeof testing.assertPrintParse !== 'function') throw new Error('missing testing.assertPrintParse')",
          "for (const subpath of ['ast', 'internal/bytes', 'internal/schema', 'dist/internal/schema.js']) {",
          "  let hidden = false",
          "  try { await import('effect-grammar/' + subpath) } catch (error) { hidden = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' }",
          "  if (!hidden) throw new Error('undeclared subpath is importable: ' + subpath)",
          "}",
          "console.log('ok')",
        ].join("\n")

        const output = yield* run("node", ["--input-type=module", "-e", script], consumer)
        assert.match(output, /^ok$/m)

        const types = [
          'import { Effect, Schema } from "effect"',
          'import * as G from "effect-grammar"',
          'import * as Binary from "effect-grammar/Binary"',
          'import { codec, type CodecOptions } from "effect-grammar/Schema"',
          'import * as Testing from "effect-grammar/testing"',
          "type Decode = { readonly decode: unique symbol }",
          "type Encode = { readonly encode: unique symbol }",
          "declare const target: Schema.Codec<string, number, Decode, Encode>",
          'const options: CodecOptions = { identifier: "Number" }',
          "const text = codec(G.integer, target, options)",
          "const binary = Binary.codec(Binary.uint8, target, options)",
          "const bytes: G.Grammar<Uint8Array, 'bytes'> = Binary.bytes(2)",
          "type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false",
          "const types: [Same<typeof text.Type, string>, Same<typeof text.Encoded, string>,",
          "  Same<typeof binary.Encoded, Uint8Array>, Same<typeof text.DecodingServices, Decode>,",
          "  Same<typeof text.EncodingServices, Encode>, Same<typeof binary.DecodingServices, Decode>,",
          "  Same<typeof binary.EncodingServices, Encode>] = [true, true, true, true, true, true, true]",
          "// @ts-expect-error Schema decoding requires the target decoding service",
          'Effect.runSync(Schema.decodeEffect(text)("1"))',
          "// @ts-expect-error Schema encoding requires the target encoding service",
          'Effect.runSync(Schema.encodeEffect(binary)("1"))',
          "// @ts-expect-error codec is only exported from the Schema adapter",
          "G.codec",
          "// @ts-expect-error CodecOptions is only exported from the Schema adapter",
          "type RemovedOptions = G.CodecOptions",
          "// @ts-expect-error decodeTo was removed",
          "G.decodeTo",
          "// @ts-expect-error raw byte strings are private",
          "Binary.takeBytes",
          "void [bytes, types, Testing.assertPrintParse]",
        ].join("\n")
        yield* fs.writeFileString(path.join(consumer, "index.mts"), types)
        const domainTypes = (yield* fs.readFileString(path.join(root, "test/domain-types.ts")))
          .replaceAll("../src/index.ts", "effect-grammar")
          .replaceAll("../src/binary.ts", "effect-grammar/Binary")
          .replaceAll("../src/text.ts", "effect-grammar/Text")
          .replaceAll("../src/schema.ts", "effect-grammar/Schema")
          .replaceAll("../src/testing.ts", "effect-grammar/testing")
        yield* fs.writeFileString(path.join(consumer, "domains.mts"), domainTypes)
        yield* run(
          "node",
          [
            path.join(root, "node_modules/typescript/bin/tsc"),
            "--ignoreConfig",
            "--noEmit",
            "--strict",
            "--target",
            "esnext",
            "--module",
            "nodenext",
            "index.mts",
            "domains.mts",
          ],
          consumer,
        )
      }),
    )
  })
})
