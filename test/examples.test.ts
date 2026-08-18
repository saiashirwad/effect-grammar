import assert from "node:assert/strict"

import { describe, it } from "vitest"

// Node built-ins via getBuiltinModule — keeps the Effect language-service
// nodeBuiltinImport diagnostic quiet in tests (subprocess smoke is intentional).
const { spawnSync } = process.getBuiltinModule(
  "child_process",
) as typeof import("node:child_process")
const { readdirSync } = process.getBuiltinModule("fs") as typeof import("node:fs")
const path = process.getBuiltinModule("path") as typeof import("node:path")

const root = path.resolve(import.meta.dirname, "..")
const examplesDir = path.join(root, "examples")

const examples = readdirSync(examplesDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()

describe("examples smoke", () => {
  for (const file of examples) {
    it(`${file} exits 0`, () => {
      const result = spawnSync(process.execPath, [path.join(examplesDir, file)], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      })
      assert.equal(
        result.status,
        0,
        [
          `${file} exited ${result.status}`,
          result.stderr ? `stderr:\n${result.stderr}` : "",
          result.stdout ? `stdout (tail):\n${result.stdout.slice(-500)}` : "",
          result.error ? `error: ${result.error.message}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    })
  }
})
