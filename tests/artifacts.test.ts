import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createRunArtifactName, createRunArtifacts, finishRunArtifacts, startIterationArtifacts } from "../src/artifacts.ts"

describe("run artifacts", () => {
  test("writes ignored project-local iteration artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-artifacts-test-"))

    try {
      const run = await createRunArtifacts({
        projectRoot: root,
        phase: "build",
        rawArgs: "1 --model provider/model",
        date: new Date(2026, 0, 2, 3, 4, 5),
      })

      expect(run.timestampId).toBe("20260102-030405")
      expect(run.runName).toBe("openralph-build-20260102-030405")
      expect(run.dir).toBe(join(root, "runs", "openralph-build-20260102-030405"))
      expect(await readFile(join(root, "runs", ".gitignore"), "utf8")).toBe("*\n")

      const iteration = await startIterationArtifacts(run, 1, ["run", "--dir", root])
      iteration.recordOutput({ stream: "stdout", chunk: "hello\n" })
      iteration.recordOutput({ stream: "stderr", chunk: "warning\n" })
      await iteration.finish({ result: { exitCode: 0, signal: null }, sentinel: "iteration-complete" })
      await finishRunArtifacts(run, {
        phase: "build",
        status: "complete",
        message: "build complete",
        launched: 1,
        tagged: 1,
        blocked: 0,
        warnings: [],
      })

      expect(await readFile(join(run.dir, "iter-001.txt"), "utf8")).toBe("hello\nwarning\n")

      const jsonl = (await readFile(join(run.dir, "iter-001.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line))
      expect(jsonl).toHaveLength(2)
      expect(jsonl[0]).toMatchObject({ iteration: 1, type: "output", stream: "stdout", chunk: "hello\n" })
      expect(jsonl[1]).toMatchObject({ iteration: 1, type: "output", stream: "stderr", chunk: "warning\n" })

      const log = await readFile(run.logPath, "utf8")
      expect(log).toContain("OpenRalph build run started")
      expect(log).toContain("iter-001 started")
      expect(log).toContain("OpenRalph build run finished")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("formats artifact run names", () => {
    expect(createRunArtifactName("plan", "20260102-030405")).toBe("openralph-plan-20260102-030405")
  })
})
