import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { runCommand, type CommandResult } from "../src/exec.ts"
import { runLoop, type LoopSummary } from "../src/loop.ts"

describe("runLoop build completion", () => {
  test("completes without tagging when no work remains and the worktree is clean", async () => {
    await withFakeOpenCode("complete-clean", async (root) => {
      const summary = await runBuild(root)

      expect(summary.status).toBe("complete")
      expect(summary.message).toBe("build complete")
      expect(summary.tagged).toBe(0)
    })
  })

  test("fails final completion when the child leaves uncommitted work", async () => {
    await withFakeOpenCode("complete-dirty", async (root) => {
      const summary = await runBuild(root)

      expect(summary.status).toBe("failed")
      expect(summary.message).toContain("dirty worktree")
      expect(summary.tagged).toBe(0)
    })
  })

  test("tags a final completion that created a clean commit", async () => {
    await withFakeOpenCode("complete-commit", async (root) => {
      const summary = await runBuild(root)

      expect(summary.status).toBe("complete")
      expect(summary.tagged).toBe(1)
      expect(summary.artifacts).toContain(join(root, "runs", "openralph-build-"))

      const tags = await runGit(root, ["tag", "--list", "openralph/build-*"])
      expect(tags.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)

      const status = await runGit(root, ["status", "--porcelain"])
      expect(status.stdout.trim()).toBe("")

      const text = await readFile(join(summary.artifacts, "iter-001.txt"), "utf8")
      expect(text).toContain("RALPH_COMPLETE")

      const jsonl = (await readFile(join(summary.artifacts, "iter-001.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line))
      expect(jsonl.some((entry) => entry.stream === "stdout" && entry.chunk.includes("RALPH_COMPLETE"))).toBe(true)

      const log = await readFile(join(summary.artifacts, "ralph.log"), "utf8")
      expect(log).toContain("OpenRalph build run finished")
      expect(log).toContain("tagged iterations: 1")
    })
  })

  test("reports push failure without losing the successful build tag", async () => {
    await withFakeOpenCode("complete-commit", async (root) => {
      const summary = await runBuild(root, "1 --push")

      expect(summary.status).toBe("failed")
      expect(summary.message).toContain("pushing")
      expect(summary.message).toContain("tagged locally")
      expect(summary.tagged).toBe(1)

      const tags = await runGit(root, ["tag", "--list", "openralph/build-*"])
      expect(tags.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    })
  })
})

async function runBuild(root: string, rawArgs = "1"): Promise<LoopSummary> {
  return runLoop({ phase: "build", rawArgs, cwd: root, options: {}, streamOutput: false })
}

async function withFakeOpenCode(scenario: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openralph-loop-test-"))
  const originalPath = process.env.PATH
  const originalScenario = process.env.OPENRALPH_TEST_SCENARIO

  try {
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFakeOpenCode(join(bin, "opencode"))
    await prepareRepo(root)

    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`
    process.env.OPENRALPH_TEST_SCENARIO = scenario

    await run(root)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath

    if (originalScenario === undefined) delete process.env.OPENRALPH_TEST_SCENARIO
    else process.env.OPENRALPH_TEST_SCENARIO = originalScenario

    await rm(root, { recursive: true, force: true })
  }
}

async function prepareRepo(root: string): Promise<void> {
  await runGit(root, ["init"])
  await runGit(root, ["checkout", "-b", "feature/test"])
  await runGit(root, ["config", "user.name", "OpenRalph Test"])
  await runGit(root, ["config", "user.email", "openralph@example.com"])
  await writeFile(join(root, "README.md"), "initial\n")
  await writeFile(join(root, "IMPLEMENTATION_PLAN.md"), "- [ ] Finish final task\n")
  await runGit(root, ["add", "."])
  await runGit(root, ["commit", "-m", "Initial commit"])
}

async function writeFakeOpenCode(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env bash
set -euo pipefail

case "\${OPENRALPH_TEST_SCENARIO:-}" in
  complete-clean)
    printf 'RALPH_COMPLETE\n'
    ;;
  complete-dirty)
    printf 'RALPH_COMPLETE\n'
    printf 'dirty\n' > dirty.txt
    ;;
  complete-commit)
    printf 'complete\n' >> result.txt
    git add result.txt
    git commit -m 'Complete final task' >/dev/null
    printf 'RALPH_COMPLETE\n'
    ;;
  *)
    printf 'unknown scenario: %s\n' "\${OPENRALPH_TEST_SCENARIO:-}" >&2
    exit 2
    ;;
esac
`,
  )
  await chmod(path, 0o755)
}

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand("git", args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}
