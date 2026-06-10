import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { buildForbiddenPathMarkers, checkReleaseVersionConsistency, scanFilesForForbiddenPaths } from "../src/release-check.ts"

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

  test("detects home paths from other developer machines", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      // Built dynamically so the release check never flags this test file itself.
      const otherDevLinuxHome = ["", "home", "somedev"].join("/")
      const otherDevMacHome = ["", "Users", "somedev"].join("/")
      await writeFile(
        join(root, "leaked.md"),
        [
          `linux path ${otherDevLinuxHome}/Projects/OpenRalph/src/loop.ts`,
          `macos path ${otherDevMacHome}/Projects/OpenRalph/src/loop.ts`,
          "container home /home/opencode/.local/share/opencode/auth.json is expected",
          "current machine marker /home/example/.config still matches explicitly",
        ].join("\n"),
      )

      const findings = await scanFilesForForbiddenPaths(root, ["leaked.md"], buildForbiddenPathMarkers(root, "/home/example"))

      expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual(["leaked.md:1", "leaked.md:2", "leaked.md:4"])
      expect(findings[0]?.reason).toBe("home directory path from a developer machine")
      expect(findings[1]?.marker).toBe(otherDevMacHome)
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

describe("release version consistency", () => {
  test("passes when package.json matches the latest CHANGELOG release heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }))
      await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-06-06\n\n## [1.2.2] - 2026-06-01\n")

      expect(await checkReleaseVersionConsistency(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports version drift between package.json and CHANGELOG", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.4" }))
      await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3] - 2026-06-06\n")

      const issues = await checkReleaseVersionConsistency(root)
      expect(issues).toHaveLength(1)
      expect(issues[0]).toContain("1.2.4")
      expect(issues[0]).toContain("1.2.3")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports a missing CHANGELOG release heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-release-check-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }))
      await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\nnotes only\n")

      const issues = await checkReleaseVersionConsistency(root)
      expect(issues).toHaveLength(1)
      expect(issues[0]).toContain("release heading")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
