import { describe, expect, test } from "bun:test"
import { parseLoopArgs } from "../src/args.ts"
import { resolveLauncherMode, runOpenRalphLauncher } from "../src/launcher.ts"
import type { LoopSummary, RunLoopInput } from "../src/loop.ts"

const hostSummary: LoopSummary = {
  phase: "plan",
  status: "complete",
  message: "planning complete",
  launched: 1,
  tagged: 0,
  blocked: 0,
  warnings: [],
  artifacts: "/repo/runs/openralph-plan-20260102-030405",
}

const noContainer = { containerEvidence: async () => false }
const allCommandsExist = async () => true
const allImagesExist = async () => true

describe("resolveLauncherMode", () => {
  test("resolves Docker host launch", async () => {
    await expect(
      resolveLauncherMode({ parsed: parseLoopArgs("plan", ""), options: { docker: { enabled: true } }, env: {}, trust: noContainer }),
    ).resolves.toBe("docker-host-launch")
  })

  test("resolves explicit host mode", async () => {
    await expect(
      resolveLauncherMode({ parsed: parseLoopArgs("plan", "--no-docker"), options: { docker: { enabled: true } }, env: {}, trust: noContainer }),
    ).resolves.toBe("host-explicit")
  })

  test("resolves Docker host launch by default", async () => {
    await expect(resolveLauncherMode({ parsed: parseLoopArgs("plan", ""), options: {}, env: {}, trust: noContainer })).resolves.toBe(
      "docker-host-launch",
    )
  })

  test("resolves host config default when Docker is disabled", async () => {
    await expect(
      resolveLauncherMode({ parsed: parseLoopArgs("plan", ""), options: { docker: { enabled: false } }, env: {}, trust: noContainer }),
    ).resolves.toBe("host-config-default")
  })

  test("requires attestation for Docker markers", async () => {
    await expect(
      resolveLauncherMode({ parsed: parseLoopArgs("plan", "--no-docker"), options: {}, env: { OPENRALPH_IN_DOCKER: "1" }, trust: noContainer }),
    ).rejects.toThrow("attestation failed")
  })

  test("resolves trusted container mode", async () => {
    await expect(
      resolveLauncherMode({
        parsed: parseLoopArgs("plan", ""),
        options: { docker: { enabled: true } },
        env: { OPENRALPH_IN_DOCKER: "1", OPENRALPH_DOCKER_TOKEN: "token" },
        trust: { containerEvidence: async () => true, readTextFile: async () => "token" },
      }),
    ).resolves.toBe("container-attested")
  })
})

describe("runOpenRalphLauncher", () => {
  test("launches Docker when enabled", async () => {
    let dockerCalled = false
    let hostCalled = false
    const onOutput = () => undefined

    const result = await runOpenRalphLauncher(
      { phase: "plan", rawArgs: "5", cwd: "/repo", options: { docker: { enabled: true } }, onOutput },
      {
        env: {},
        trust: noContainer,
        commandExists: allCommandsExist,
        dockerImageExists: allImagesExist,
        requireGitContext: async () => ({ root: "/repo", branch: "feature/test" }),
        runDockerLoop: async (input) => {
          dockerCalled = true
          expect(input.projectRoot).toBe("/repo")
          expect(input.rawArgs).toBe("5")
          expect(input.onOutput).toBe(onOutput)
          return {
            exitCode: 0,
            signal: null,
            stdout: "OpenRalph plan complete: planning complete\nlaunched iterations: 1\nartifacts: /workspace/runs/openralph-plan-20260102-030405\n",
            stderr: "",
          }
        },
        runLoop: async () => {
          hostCalled = true
          return hostSummary
        },
      },
    )

    expect(dockerCalled).toBe(true)
    expect(hostCalled).toBe(false)
    expect(result.mode).toBe("docker-host-launch")
    expect(result.summary).toContain("OpenRalph plan Docker execution completed")
    expect(result.summary).toContain("OpenRalph plan complete: planning complete")
    expect(result.summary).toContain("artifacts: /repo/runs/openralph-plan-20260102-030405")
    expect(result.summary).not.toContain("/workspace/runs")
  })

  test("runs host loop when no-docker is present", async () => {
    let dockerCalled = false
    let hostInput: RunLoopInput | undefined
    const onOutput = () => undefined

    const result = await runOpenRalphLauncher(
      { phase: "plan", rawArgs: "5 --no-docker", cwd: "/repo", options: { docker: { enabled: true } }, onOutput },
      {
        env: {},
        trust: noContainer,
        commandExists: allCommandsExist,
        dockerImageExists: allImagesExist,
        runDockerLoop: async () => {
          dockerCalled = true
          throw new Error("unexpected Docker call")
        },
        runLoop: async (input) => {
          hostInput = input
          return hostSummary
        },
      },
    )

    expect(dockerCalled).toBe(false)
    expect(hostInput?.executionMode).toBe("host-explicit")
    expect(hostInput?.onOutput).toBe(onOutput)
    expect(result.summary).toContain("OpenRalph plan complete: planning complete")
  })

  test("trusted container calls host loop with container context", async () => {
    let dockerCalled = false
    let hostInput: RunLoopInput | undefined

    await runOpenRalphLauncher(
      { phase: "plan", rawArgs: "5", cwd: "/repo", options: { docker: { enabled: true } } },
      {
        env: { OPENRALPH_IN_DOCKER: "1", OPENRALPH_DOCKER_TOKEN: "token" },
        trust: { containerEvidence: async () => true, readTextFile: async () => "token" },
        commandExists: allCommandsExist,
        runDockerLoop: async () => {
          dockerCalled = true
          throw new Error("unexpected Docker call")
        },
        runLoop: async (input) => {
          hostInput = input
          return hostSummary
        },
      },
    )

    expect(dockerCalled).toBe(false)
    expect(hostInput?.executionMode).toBe("container-attested")
  })

  test("rejects push in Docker mode", async () => {
    await expect(
      runOpenRalphLauncher(
        { phase: "build", rawArgs: "--push", cwd: "/repo", options: { docker: { enabled: true } } },
        { env: {}, trust: noContainer },
      ),
    ).rejects.toThrow("--push is not supported in Docker mode")
  })

  test("reports missing host commands before running the loop", async () => {
    let hostCalled = false

    await expect(
      runOpenRalphLauncher(
        { phase: "plan", rawArgs: "5", cwd: "/repo", options: { docker: { enabled: false } } },
        {
          env: {},
          trust: noContainer,
          commandExists: async (command) => command !== "opencode",
          runLoop: async () => {
            hostCalled = true
            return hostSummary
          },
        },
      ),
    ).rejects.toThrow("Install opencode")

    expect(hostCalled).toBe(false)
  })

  test("reports missing Docker image before running the container", async () => {
    let dockerCalled = false

    await expect(
      runOpenRalphLauncher(
        { phase: "plan", rawArgs: "5", cwd: "/repo", options: {} },
        {
          env: {},
          trust: noContainer,
          commandExists: allCommandsExist,
          dockerImageExists: async (image, cwd) => {
            expect(image).toBe("openralph:local")
            expect(cwd).toBe("/repo")
            return false
          },
          runDockerLoop: async () => {
            dockerCalled = true
            throw new Error("unexpected Docker call")
          },
        },
      ),
    ).rejects.toThrow("Docker image openralph:local was not found")

    expect(dockerCalled).toBe(false)
  })

  test("reports Docker failure without host fallback", async () => {
    let hostCalled = false

    await expect(
      runOpenRalphLauncher(
        { phase: "plan", rawArgs: "5 --model provider/model", cwd: "/repo", options: { docker: { enabled: true } } },
        {
          env: {},
          trust: noContainer,
          commandExists: allCommandsExist,
          dockerImageExists: allImagesExist,
          requireGitContext: async () => ({ root: "/repo", branch: "feature/test" }),
          runDockerLoop: async () => ({
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "docker failed",
          }),
          runLoop: async () => {
            hostCalled = true
            return hostSummary
          },
        },
      ),
    ).rejects.toThrow("did not fall back to host execution")

    expect(hostCalled).toBe(false)
  })

  test("reports inner Ralph loop failure from Docker output", async () => {
    await expect(
      runOpenRalphLauncher(
        { phase: "build", rawArgs: "1", cwd: "/repo", options: { docker: { enabled: true } } },
        {
          env: {},
          trust: noContainer,
          commandExists: allCommandsExist,
          dockerImageExists: allImagesExist,
          requireGitContext: async () => ({ root: "/repo", branch: "feature/test" }),
          runDockerLoop: async () => ({
            exitCode: 0,
            signal: null,
            stdout: "OpenRalph build failed: reached max iterations (1) after a failed child\nlaunched iterations: 1\n",
            stderr: "",
          }),
        },
      ),
    ).rejects.toThrow("build loop reported failure")
  })
})
