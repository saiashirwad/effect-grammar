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
    it.effect("ships exactly one dist module per source module", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { root, workspace, tarball } = yield* Packed
        const shipped = (yield* run("tar", ["-tzf", tarball], workspace))
          .split("\n")
          .flatMap((entry) => (/^package\/dist\/[^/]+\.js$/.test(entry) ? [path.basename(entry, ".js")] : []))
          .sort()
        const sources = (yield* fs.readDirectory(path.join(root, "src")))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => path.basename(name, ".ts"))
          .sort()
        assert.deepStrictEqual(shipped, sources)
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
          "const testing = await import('effect-grammar/testing')",
          `const expected = ${expected}`,
          "const actual = Object.keys(root).sort()",
          "if (JSON.stringify(actual) !== JSON.stringify(expected)) {",
          "  throw new Error('root exports differ: ' + JSON.stringify({ expected, actual }))",
          "}",
          "if (typeof binary.bits !== 'function') throw new Error('missing Binary.bits')",
          "if (typeof root.codec !== 'function') throw new Error('missing codec')",
          "if (typeof testing.assertPrintParse !== 'function') throw new Error('missing testing.assertPrintParse')",
          "let hidden = false",
          "try { await import('effect-grammar/ast') } catch { hidden = true }",
          "if (!hidden) throw new Error('undeclared subpath ./ast is importable')",
          "console.log('ok')",
        ].join("\n")

        const output = yield* run("node", ["--input-type=module", "-e", script], consumer)
        assert.match(output, /^ok$/m)
      }),
    )
  })
})
