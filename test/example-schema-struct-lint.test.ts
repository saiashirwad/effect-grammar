import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const directory = mkdtempSync(join(tmpdir(), "grammar-example-lint-"))
mkdirSync(join(directory, "examples"))
mkdirSync(join(directory, "src"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const lint = (code: string, folder = "examples") => {
  const file = join(directory, folder, "fixture.ts")
  writeFileSync(file, code)
  return spawnSync(process.execPath, [
    resolve("node_modules/oxlint/bin/oxlint"),
    "--config",
    resolve("oxlint.config.ts"),
    "-A",
    "all",
    "-D",
    "anti-slop/no-example-schema-struct",
    file,
  ], { encoding: "utf8" })
}

describe("example schemas derive their object structure", () => {
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

  it.each(historical)("rejects historical structure: %s", (snippet) => {
    const result = lint(`import { Schema } from "effect"\n${snippet}`)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("Grammar.gen and GrammarSchema.codec")
    expect(result.stdout).toContain("Schema.toType")
  })

  it.each([
    `import { Schema as S } from "effect"; S.Struct({ value: S.String })`,
    `import * as S from "effect/Schema"; S.Struct({ value: S.String })`,
    `import { Struct as object } from "effect/Schema"; object({})`,
    `import { Schema as S } from "effect"; S["Struct"]({})`,
  ])("resolves import aliases: %s", (code) => {
    const result = lint(code)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("no-example-schema-struct")
  })

  it.each([
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
  ])("allows derived structures and unrelated schemas: %s", (code) => {
    const result = lint(code)
    expect(result.stdout + result.stderr).not.toContain("no-example-schema-struct")
    expect(result.status).toBe(0)
  })

  it("does not prohibit supported explicit object targets library-wide", () => {
    const result = lint(`import { Schema } from "effect"; Schema.Struct({ value: Schema.String })`, "src")
    expect(result.status).toBe(0)
  })
})
