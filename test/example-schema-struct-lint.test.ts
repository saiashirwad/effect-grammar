import { NodeServices } from "@effect/platform-node"
import { describe, expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

const lint = (code: string, folder = "examples") =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grammar-example-lint-" })
    yield* fs.makeDirectory(path.join(directory, folder))
    const file = path.join(directory, folder, "fixture.ts")
    yield* fs.writeFileString(file, code)
    const handle = yield* ChildProcess.make("node", [
      path.join(root, "node_modules/oxlint/bin/oxlint"),
      "--config",
      path.join(root, "oxlint.config.ts"),
      "-A",
      "all",
      "-D",
      "anti-slop/no-example-schema-struct",
      file,
    ], { cwd: root })
    const [output, status] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], {
      concurrency: 2,
    })
    return { output, status }
  }).pipe(Effect.scoped)

describe("example schemas derive their object structure", () => {
  layer(NodeServices.layer)((it) => {
    // Removed by 6a1c0c2 (connection-string) and 3cd7935 (scheme/github-search).
    const historical = [
      `const ConnectionInfo = Schema.Struct({
  user: Schema.NonEmptyString,
  password: Schema.UndefinedOr(Schema.String),
  host: Schema.NonEmptyString,
  port: Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  database: Schema.NonEmptyString,
  params: Schema.Record(Schema.String, Schema.String),
})`,
      `const NumberAtom = Schema.Struct({ kind: Schema.Literal("number"), value: Schema.Finite })`,
      `const WordValueSchema = Schema.Struct({ kind: Schema.Literal("word"), value: Schema.String })`,
    ]

    for (const snippet of historical) {
      it.effect(`rejects historical structure: ${snippet}`, () =>
        Effect.gen(function*() {
          const result = yield* lint(`import { Schema } from "effect"\n${snippet}`)
          expect(result.status).toBe(1)
          expect(result.output).toContain("Grammar.gen and GrammarSchema.codec")
          expect(result.output).toContain("Schema.toType")
        }))
    }

    for (
      const code of [
        `import { Schema as S } from "effect"; S.Struct({ value: S.String })`,
        `import * as S from "effect/Schema"; S.Struct({ value: S.String })`,
        `import { Struct as object } from "effect/Schema"; object({})`,
        `import { Schema as S } from "effect"; S["Struct"]({})`,
      ]
    ) {
      it.effect(`resolves import aliases: ${code}`, () =>
        Effect.gen(function*() {
          const result = yield* lint(code)
          expect(result.status).toBe(1)
          expect(result.output).toContain("no-example-schema-struct")
        }))
    }

    for (
      const code of [
        `import { Schema } from "effect"
const target = Schema.Finite
const json = Schema.Record(Schema.String, Schema.Unknown)
const api = Schema.Union([Schema.String, Schema.Number])
const value = Schema.toType(codec)`,
        `import { Schema } from "another-library"; Schema.Struct({})`,
        `import { Schema } from "effect"; function example(Schema) { return Schema.Struct({}) }`,
        `import { Schema } from "effect"; const text = "Schema.Struct({})" // Schema.Struct({})`,
        `import * as Grammar from "../src/index.ts"
import * as GrammarSchema from "../src/schema.ts"
const grammar = Grammar.gen(function*() { const value = yield* Grammar.integer; return { value } })
const codec = GrammarSchema.codec(grammar)`,
      ]
    ) {
      it.effect(`allows derived structures and unrelated schemas: ${code}`, () =>
        Effect.gen(function*() {
          const result = yield* lint(code)
          expect(result.output).not.toContain("no-example-schema-struct")
          expect(result.status).toBe(0)
        }))
    }

    it.effect("does not prohibit supported explicit object targets library-wide", () =>
      Effect.gen(function*() {
        const result = yield* lint(`import { Schema } from "effect"; Schema.Struct({ value: Schema.String })`, "src")
        expect(result.status).toBe(0)
      }))
  })
})
