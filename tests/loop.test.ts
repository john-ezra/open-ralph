import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { runCommand, type CommandOutputEvent, type CommandResult } from "../src/exec.ts"
import { runLoop, type LoopSummary } from "../src/loop.ts"

describe("runLoop heartbeat", () => {
  test("emits heartbeat without adding it to child artifacts", async () => {
    await withFakeOpenCode("plan-delayed-output", async (root) => {
      const output: CommandOutputEvent[] = []
      const summary = await runLoop({
        phase: "plan",
        rawArgs: "1",
        cwd: root,
        options: {},
        streamOutput: false,
        onOutput: (event) => output.push(event),
        heartbeatIntervalMs: 10,
      })

      expect(summary.status).toBe("complete")

      const chunks = output.map((event) => event.chunk)
      const startedIndex = chunks.findIndex((chunk) => chunk.includes("OpenRalph plan iter-001 started. Waiting for opencode output..."))
      const heartbeatIndex = chunks.findIndex((chunk) => chunk.includes("OpenRalph plan iter-001 still running"))
      const childIndex = chunks.findIndex((chunk) => chunk.includes("delayed plan output"))

      expect(startedIndex).toBeGreaterThanOrEqual(0)
      expect(heartbeatIndex).toBeGreaterThanOrEqual(0)
      expect(childIndex).toBeGreaterThanOrEqual(0)
      expect(startedIndex).toBeLessThan(childIndex)
      expect(heartbeatIndex).toBeLessThan(childIndex)
      expect(output[heartbeatIndex]?.stream).toBe("stderr")

      const text = await readFile(join(summary.artifacts, "iter-001.txt"), "utf8")
      expect(text).toContain("delayed plan output")
      expect(text).toContain("RALPH_PLAN_COMPLETE")
      expect(text).not.toContain("OpenRalph plan iter-001")
    })
  })
})

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

  test("fails when a child masks files by editing git info exclude", async () => {
    await withFakeOpenCode("exclude-mutation", async (root) => {
      const summary = await runBuild(root)

      expect(summary.status).toBe("failed")
      expect(summary.message).toContain(".git/info/exclude")
      expect(summary.tagged).toBe(0)

      const tags = await runGit(root, ["tag", "--list", "openralph/build-*"])
      expect(tags.stdout.trim()).toBe("")

      const log = await readFile(join(summary.artifacts, "ralph.log"), "utf8")
      expect(log).toContain("status: build child modified .git/info/exclude")
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
  plan-delayed-output)
    sleep 0.2
    printf 'delayed plan output\n'
    printf 'RALPH_PLAN_COMPLETE\n'
    ;;
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
  exclude-mutation)
    mkdir -p .opencode
    printf '{"plugin":["open-ralph"]}\n' > .opencode/opencode.json
    printf '.opencode/\n' >> .git/info/exclude
    printf 'complete\n' >> result.txt
    git add result.txt
    git commit -m 'Complete task while masking config' >/dev/null
    printf 'RALPH_ITERATION_COMPLETE\n'
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
