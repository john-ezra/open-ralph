import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { runCommand, type CommandResult } from "../src/exec.ts"
import { buildDefensiveGitArgs, commitPath, hasPathChanges } from "../src/git.ts"

describe("buildDefensiveGitArgs", () => {
  test("disables repo-controlled Git execution hooks", () => {
    const args = buildDefensiveGitArgs(["status", "--porcelain"])

    expect(args).toContain("--no-pager")
    expect(args).toContain("core.hooksPath=/dev/null")
    expect(args).toContain("core.fsmonitor=false")
    expect(args).toContain("core.pager=cat")
    expect(args.slice(-2)).toEqual(["status", "--porcelain"])
  })
})

describe("commitPath", () => {
  test("commits only the requested path", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-git-test-"))

    try {
      await runGit(root, ["init"])
      await runGit(root, ["checkout", "-b", "feature/test"])
      await runGit(root, ["config", "user.name", "OpenRalph Test"])
      await runGit(root, ["config", "user.email", "openralph@example.com"])
      await writeFile(join(root, "README.md"), "initial\n")
      await runGit(root, ["add", "."])
      await runGit(root, ["commit", "-m", "Initial commit"])

      await writeFile(join(root, "IMPLEMENTATION_PLAN.md"), "plan\n")
      await writeFile(join(root, "other.txt"), "other\n")
      await runGit(root, ["add", "other.txt"])

      expect(await hasPathChanges(root, "IMPLEMENTATION_PLAN.md")).toBe(true)
      await commitPath(root, "IMPLEMENTATION_PLAN.md", "Update implementation plan")

      const committedFiles = await runGit(root, ["show", "--name-only", "--pretty=format:", "HEAD"])
      expect(committedFiles.stdout.trim().split(/\r?\n/).filter(Boolean)).toEqual(["IMPLEMENTATION_PLAN.md"])

      const status = await runGit(root, ["status", "--porcelain"])
      expect(status.stdout).toContain("A  other.txt")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand("git", args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}
