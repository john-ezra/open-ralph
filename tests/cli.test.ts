import { describe, expect, test } from "bun:test"
import { runCli } from "../src/cli.ts"

describe("runCli", () => {
  test("rejects unknown commands with usage", async () => {
    let stderr = ""
    const exitCode = await runCli(["nope"], {
      stderr: {
        write: (chunk) => {
          stderr += String(chunk)
          return true
        },
      },
    })

    expect(exitCode).toBe(2)
    expect(stderr).toContain("openralph plan")
    expect(stderr).toContain("openralph build")
  })

  test("passes args and env options to the launcher", async () => {
    let stdout = ""
    const exitCode = await runCli(["plan", "5", "--no-docker"], {
      env: { OPENRALPH_OPTIONS_JSON: '{"planModel":"provider/plan"}' },
      cwd: "/repo",
      stdout: {
        write: (chunk) => {
          stdout += String(chunk)
          return true
        },
      },
      runLauncher: async (input) => {
        expect(input.phase).toBe("plan")
        expect(input.rawArgs).toBe("5 --no-docker")
        expect(input.cwd).toBe("/repo")
        expect(input.options.planModel).toBe("provider/plan")
        expect(input.streamOutput).toBe(true)
        return { phase: "plan", mode: "host-explicit", status: "complete", summary: "OpenRalph plan complete: planning complete" }
      },
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain("OpenRalph plan complete")
  })

  test("returns non-zero for failed launcher summaries", async () => {
    const exitCode = await runCli(["build", "1"], {
      stdout: { write: () => true },
      runLauncher: async () => ({ phase: "build", mode: "host-config-default", status: "failed", summary: "OpenRalph build failed: no sentinel" }),
    })

    expect(exitCode).toBe(1)
  })

  test("returns non-zero for blocked launcher summaries", async () => {
    const exitCode = await runCli(["build", "1"], {
      stdout: { write: () => true },
      runLauncher: async () => ({
        phase: "build",
        mode: "host-config-default",
        status: "blocked",
        summary: "OpenRalph build blocked: resolve the blocker documented in IMPLEMENTATION_PLAN.md",
      }),
    })

    expect(exitCode).toBe(1)
  })

  test("returns 130 for stopped launcher summaries", async () => {
    const exitCode = await runCli(["build", "1"], {
      stdout: { write: () => true },
      runLauncher: async () => ({ phase: "build", mode: "docker-host-launch", status: "stopped", summary: "OpenRalph build stopped: stopped by user" }),
    })

    expect(exitCode).toBe(130)
  })

  test("returns zero for max-reached launcher summaries", async () => {
    const exitCode = await runCli(["build", "1"], {
      stdout: { write: () => true },
      runLauncher: async () => ({ phase: "build", mode: "host-explicit", status: "max-reached", summary: "OpenRalph build max-reached: reached max iterations (1)" }),
    })

    expect(exitCode).toBe(0)
  })

  test("builds the Docker image with documented flags", async () => {
    let stdout = ""
    const exitCode = await runCli(["docker", "build", "--tag", "openralph:test", "--no-cache"], {
      stdout: {
        write: (chunk) => {
          stdout += String(chunk)
          return true
        },
      },
      buildDockerImage: async (input) => {
        expect(input).toBeDefined()
        if (!input) throw new Error("expected Docker build input")
        expect(input.tag).toBe("openralph:test")
        expect(input.noCache).toBe(true)
        expect(input.streamOutput).toBe(true)
        expect(input.captureOutput).toBe(true)
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain("OpenRalph Docker image built: openralph:test")
  })

  test("uses the default Docker image tag", async () => {
    const exitCode = await runCli(["docker", "build"], {
      stdout: { write: () => true },
      buildDockerImage: async (input) => {
        expect(input).toBeDefined()
        if (!input) throw new Error("expected Docker build input")
        expect(input.tag).toBe("openralph:local")
        expect(input.noCache).toBe(false)
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    })

    expect(exitCode).toBe(0)
  })

  test("rejects invalid Docker image tags", async () => {
    let stderr = ""
    const exitCode = await runCli(["docker", "build", "--tag", "openralph:test,bad"], {
      stderr: {
        write: (chunk) => {
          stderr += String(chunk)
          return true
        },
      },
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain("valid Docker image reference")
  })

  test("returns non-zero when Docker image build fails", async () => {
    let stderr = ""
    const exitCode = await runCli(["docker", "build"], {
      stdout: { write: () => true },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk)
          return true
        },
      },
      buildDockerImage: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "nope" }),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain("Docker image build failed")
  })
})
