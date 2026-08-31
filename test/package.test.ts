import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as index from "../src/index.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const run = (command: string, args: ReadonlyArray<string>, cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

let workspace: string
let tarball: string

// Packs the library, installs the tarball in a throwaway project, and imports
// every declared export. This fails if the build ships stale modules or if a
// declared subpath (like ./testing) is missing from the published package.
describe("packaged exports", () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "effect-grammar-pack-"))
    run("pnpm", ["build"], root)
    run("pnpm", ["pack", "--pack-destination", workspace], root)
    const packed = readdirSync(workspace).find((name) => name.endsWith(".tgz"))
    if (packed === undefined) throw new Error("pnpm pack produced no tarball")
    tarball = join(workspace, packed)
  }, 120_000)

  afterAll(() => {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  })

  it("ships exactly one dist module per source module", () => {
    const shipped = run("tar", ["-tzf", tarball], workspace)
      .split("\n")
      .flatMap((entry) =>
        /^package\/dist\/[^/]+\.js$/.test(entry) ? [basename(entry, ".js")] : [],
      )
      .sort()
    const sources = readdirSync(join(root, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => basename(name, ".ts"))
      .sort()
    expect(shipped).toEqual(sources)
  })

  it("imports every declared export and hides undeclared files", () => {
    const consumer = join(workspace, "consumer")
    mkdirSync(join(consumer, "node_modules"), { recursive: true })
    run("tar", ["-xzf", tarball], consumer)
    symlinkSync(join(consumer, "package"), join(consumer, "node_modules", "effect-grammar"), "dir")
    const effect = resolve(root, "node_modules", "effect")
    if (!existsSync(effect)) throw new Error("effect is not installed in the workspace")
    symlinkSync(effect, join(consumer, "node_modules", "effect"), "dir")

    const script = [
      "const root = await import('effect-grammar')",
      "const schema = await import('effect-grammar/Schema')",
      "const testing = await import('effect-grammar/testing')",
      `for (const name of ${JSON.stringify(Object.keys(index))}) {`,
      "  if (!(name in root)) throw new Error('missing export ' + name)",
      "}",
      "if (typeof schema.codec !== 'function') throw new Error('missing Schema.codec')",
      "if (typeof testing.assertPrintParse !== 'function') throw new Error('missing testing.assertPrintParse')",
      "let hidden = false",
      "try { await import('effect-grammar/ast') } catch { hidden = true }",
      "if (!hidden) throw new Error('undeclared subpath ./ast is importable')",
      "console.log('ok')",
    ].join("\n")

    const output = run("node", ["--input-type=module", "-e", script], consumer)
    expect(output.trim()).toBe("ok")
  })
})
