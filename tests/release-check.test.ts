import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { buildForbiddenPathMarkers, scanFilesForForbiddenPaths } from "../src/release-check.ts"

describe("release path check", () => {
  test("detects home paths, home file URLs, and local checkout paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      await mkdir(join(root, "docs"))
      await writeFile(join(root, "README.md"), "safe docs\n")
      await writeFile(
        join(root, "docs", "bad.md"),
        [
          "absolute /home/example/.config/opencode path",
          "url file:///home/example/Projects/OpenRalph/src/plugin.ts",
          `checkout ${root}/src/plugin.ts`,
        ].join("\n"),
      )

      const findings = await scanFilesForForbiddenPaths(root, ["README.md", "docs/bad.md"], buildForbiddenPathMarkers(root, "/home/example"))

      expect(findings).toHaveLength(3)
      expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual(["docs/bad.md:1", "docs/bad.md:2", "docs/bad.md:3"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("skips files already deleted from the working tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      await writeFile(join(root, "README.md"), "safe docs\n")

      const findings = await scanFilesForForbiddenPaths(root, ["README.md", "deleted.md"], buildForbiddenPathMarkers(root, "/home/example"))

      expect(findings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
