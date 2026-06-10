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

describe("runLoop plan completion", () => {
  test("requires a fresh review after implementation plan changes", async () => {
    await withFakeOpenCode("plan-update", async (root) => {
      await runGit(root, ["rm", "IMPLEMENTATION_PLAN.md"])
      await runGit(root, ["commit", "-m", "Remove implementation plan"])

      const summary = await runPlan(root, "2")

      expect(summary.status).toBe("complete")
      expect(summary.message).toBe("planning complete; committed IMPLEMENTATION_PLAN.md")
      expect(summary.launched).toBe(2)

      const head = await runGit(root, ["log", "--oneline", "-1"])
      expect(head.stdout).toContain("Update implementation plan")

      const plan = await readFile(join(root, "IMPLEMENTATION_PLAN.md"), "utf8")
      expect(plan).toContain("Planned from specs")

      const status = await runGit(root, ["status", "--porcelain"])
      expect(status.stdout.trim()).toBe("")

      const log = await readFile(join(summary.artifacts, "ralph.log"), "utf8")
      expect(log).toContain("status: planning continues; plan changed during iteration")
      expect(log).toContain("sentinel: RALPH_PLAN_COMPLETE")
      expect(log).toContain("message: planning complete; committed IMPLEMENTATION_PLAN.md")
    })
  })

  test("completes stable existing plans in one iteration", async () => {
    await withFakeOpenCode("plan-stable", async (root) => {
      const summary = await runPlan(root)

      expect(summary.status).toBe("complete")
      expect(summary.message).toBe("planning complete")
      expect(summary.launched).toBe(1)

      const head = await runGit(root, ["log", "--oneline", "-1"])
      expect(head.stdout).toContain("Initial commit")

      const status = await runGit(root, ["status", "--porcelain"])
      expect(status.stdout.trim()).toBe("")
    })
  })

  test("commits only the implementation plan and warns when other dirty files remain", async () => {
    await withFakeOpenCode("plan-update-with-dirty", async (root) => {
      const summary = await runPlan(root, "2")

      expect(summary.status).toBe("complete")
      expect(summary.message).toBe("planning complete; committed IMPLEMENTATION_PLAN.md")
      expect(summary.warnings.join("\n")).toContain("worktree remains dirty after planning")
      expect(summary.warnings.join("\n")).toContain("?? scratch.txt")

      const committedFiles = await runGit(root, ["show", "--name-only", "--pretty=format:", "HEAD"])
      expect(committedFiles.stdout.trim().split(/\r?\n/).filter(Boolean)).toEqual(["IMPLEMENTATION_PLAN.md"])

      const status = await runGit(root, ["status", "--porcelain"])
      expect(status.stdout).toContain("?? scratch.txt")
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

  test("fails before the first build iteration when the worktree starts dirty", async () => {
    await withFakeOpenCode("complete-commit", async (root) => {
      await mkdir(join(root, ".opencode"))
      await writeFile(join(root, ".opencode", "opencode.json"), "{}\n")

      const summary = await runBuild(root)

      expect(summary.status).toBe("failed")
      expect(summary.launched).toBe(0)
      expect(summary.tagged).toBe(0)
      expect(summary.message).toContain("Build requires a clean Git worktree")
      expect(summary.message).toContain(".opencode/")
      expect(summary.message).toContain("global plugin install")

      const tags = await runGit(root, ["tag", "--list", "openralph/build-*"])
      expect(tags.stdout.trim()).toBe("")

      const log = await readFile(join(summary.artifacts, "ralph.log"), "utf8")
      expect(log).toContain("OpenRalph build run finished")
      expect(log).toContain("launched iterations: 0")
      expect(log).not.toContain("iter-001 started")
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

describe("runLoop failure handling", () => {
  test("stops after 3 consecutive child failures", async () => {
    await withFakeOpenCode("child-fail", async (root) => {
      const summary = await runBuild(root, "")

      expect(summary.status).toBe("failed")
      expect(summary.launched).toBe(3)
      expect(summary.message).toContain("3 consecutive child failures")
      expect(summary.message).toContain("exit code 1")
    })
  })

  test("treats a clean build exit without a sentinel as a failure", async () => {
    await withFakeOpenCode("build-no-sentinel", async (root) => {
      const summary = await runBuild(root, "")

      expect(summary.status).toBe("failed")
      expect(summary.launched).toBe(3)
      expect(summary.message).toContain("without a Ralph sentinel")
    })
  })

  test("fails iteration completion that did not create a commit", async () => {
    await withFakeOpenCode("iteration-no-commit", async (root) => {
      const summary = await runBuild(root, "")

      expect(summary.status).toBe("failed")
      expect(summary.launched).toBe(3)
      expect(summary.message).toContain("did not create a new commit")
    })
  })

  test("stops blocked runs after 3 consecutive blocked iterations", async () => {
    await withFakeOpenCode("build-blocked", async (root) => {
      const summary = await runBuild(root, "")

      expect(summary.status).toBe("blocked")
      expect(summary.launched).toBe(3)
      expect(summary.blocked).toBe(3)
      expect(summary.message).toContain("3 consecutive blocked iterations")
    })
  })

  test("fails plan iterations with no sentinel and no plan change", async () => {
    await withFakeOpenCode("plan-no-progress", async (root) => {
      const summary = await runPlan(root, "")

      expect(summary.status).toBe("failed")
      expect(summary.launched).toBe(3)
      expect(summary.message).toContain("without printing RALPH_PLAN_COMPLETE")
    })
  })

  test("stops cleanly at max iterations after committed work", async () => {
    await withFakeOpenCode("iterate-commit", async (root) => {
      const summary = await runBuild(root, "2")

      expect(summary.status).toBe("max-reached")
      expect(summary.launched).toBe(2)
      expect(summary.tagged).toBe(2)
    })
  })
})

describe("runLoop sentinel hygiene", () => {
  test("ignores plan sentinels that are not near the end of stdout", async () => {
    await withFakeOpenCode("plan-echo", async (root) => {
      const summary = await runPlan(root, "1")

      expect(summary.status).toBe("failed")
      expect(summary.message).toContain("without printing RALPH_PLAN_COMPLETE")
    })
  })

  test("ignores plan sentinels printed to stderr", async () => {
    await withFakeOpenCode("plan-stderr-sentinel", async (root) => {
      const summary = await runPlan(root, "1")

      expect(summary.status).toBe("failed")
      expect(summary.message).toContain("without printing RALPH_PLAN_COMPLETE")
    })
  })
})

describe("runLoop cancellation", () => {
  test("stops on abort without launching another iteration", async () => {
    await withFakeOpenCode("build-slow", async (root) => {
      const controller = new AbortController()
      const summary = await runLoop({
        phase: "build",
        rawArgs: "",
        cwd: root,
        options: {},
        streamOutput: false,
        signal: controller.signal,
        heartbeatIntervalMs: 50,
        onOutput: () => {
          if (!controller.signal.aborted) controller.abort()
        },
      })

      expect(summary.status).toBe("stopped")
      expect(summary.launched).toBe(1)
      expect(summary.message).toContain("stopped by user")
    })
  })
})

async function runPlan(root: string, rawArgs = "1"): Promise<LoopSummary> {
  return runLoop({ phase: "plan", rawArgs, cwd: root, options: {}, streamOutput: false })
}

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

next_iteration() {
  local count_file="runs/openralph-test-\${OPENRALPH_TEST_SCENARIO:-unknown}.count"
  local count=0
  mkdir -p runs
  if [ -f "$count_file" ]; then
    read -r count < "$count_file"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  printf '%s\n' "$count"
}

case "\${OPENRALPH_TEST_SCENARIO:-}" in
  plan-delayed-output)
    sleep 0.2
    printf 'delayed plan output\n'
    printf 'RALPH_PLAN_COMPLETE\n'
    ;;
  plan-stable)
    printf 'RALPH_PLAN_COMPLETE\n'
    ;;
  plan-update)
    count=$(next_iteration)
    if [ "$count" -eq 1 ]; then
      printf -- '- [ ] Planned from specs\n' > IMPLEMENTATION_PLAN.md
    fi
    printf 'RALPH_PLAN_COMPLETE\n'
    ;;
  plan-update-with-dirty)
    count=$(next_iteration)
    if [ "$count" -eq 1 ]; then
      printf -- '- [ ] Planned from specs\n' > IMPLEMENTATION_PLAN.md
      printf 'scratch\n' > scratch.txt
    fi
    printf 'RALPH_PLAN_COMPLETE\n'
    ;;
  complete-clean)
    printf 'RALPH_COMPLETE\n'
    ;;
  child-fail)
    printf 'iteration exploded\n' >&2
    exit 1
    ;;
  build-no-sentinel)
    printf 'did some work but forgot the sentinel\n'
    ;;
  build-blocked)
    printf 'RALPH_BLOCKED\n'
    ;;
  plan-no-progress)
    printf 'studied the specs, changed nothing\n'
    ;;
  plan-echo)
    printf 'RALPH_PLAN_COMPLETE\n'
    for i in $(seq 1 12); do
      printf 'trailing line %s\n' "$i"
    done
    ;;
  plan-stderr-sentinel)
    printf 'RALPH_PLAN_COMPLETE\n' >&2
    ;;
  iteration-no-commit)
    printf 'RALPH_ITERATION_COMPLETE\n'
    ;;
  iterate-commit)
    printf 'work\n' >> result.txt
    git add result.txt
    git commit -m 'Iteration work' >/dev/null
    printf 'RALPH_ITERATION_COMPLETE\n'
    ;;
  build-slow)
    sleep 5
    printf 'RALPH_BLOCKED\n'
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
    printf '{"plugin":["@john-ezra/open-ralph"]}\n' > .opencode/opencode.json
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
