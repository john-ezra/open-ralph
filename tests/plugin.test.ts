import { describe, expect, test } from "bun:test"
import plugin from "../src/plugin.ts"
import { createHostLoopToken } from "../src/trust.ts"

describe("plugin config", () => {
  test("removes public prompt-backed Ralph commands", async () => {
    const original = captureEnv()
    try {
      clearOpenRalphEnv()
      const hooks = await plugin({ directory: process.cwd() } as never, { defineModel: "provider/define" })
      const cfg: {
        agent?: Record<
          string,
          { mode?: string; permission?: { edit?: string; bash?: string; webfetch?: string; doom_loop?: string; external_directory?: string }; steps?: number }
        >
        command?: Record<string, { template: string; description?: string; model?: string; agent?: string }>
      } = {
        agent: {
          "openralph-orchestrator": { mode: "primary" },
        },
        command: {
          "ralph-define": { template: "stale define" },
          "ralph-plan": { template: "stale plan" },
          "ralph-build": { template: "stale build" },
        },
      }

      await hooks.config?.(cfg as never)

      expect(Object.keys(cfg.command ?? {}).sort()).toEqual([])
      expect(cfg.command?.["ralph-define"]).toBeUndefined()
      expect(cfg.command?.["ralph-plan"]).toBeUndefined()
      expect(cfg.command?.["ralph-build"]).toBeUndefined()
      expect(cfg.agent?.["openralph-orchestrator"]).toBeUndefined()
    } finally {
      restoreEnv(original)
    }
  })

  test("injects internal iteration commands only for authorized loop children", async () => {
    const token = await createHostLoopToken()
    const original = captureEnv()
    try {
      clearOpenRalphEnv()
      applyEnv({ OPENRALPH_LOOP_CHILD: "1", ...token.env })
      const hooks = await plugin({ directory: process.cwd() } as never, {})
      const cfg: { command?: Record<string, { template: string; description?: string }> } = {}

      await hooks.config?.(cfg as never)

      expect(Object.keys(cfg.command ?? {}).sort()).toEqual(["ralph-build-iteration", "ralph-plan-iteration"])
      expect(cfg.command?.["ralph-plan-iteration"]?.template).toContain("RALPH_PLAN_COMPLETE")
      expect(cfg.command?.["ralph-build-iteration"]?.template).toContain("RALPH_ITERATION_COMPLETE")
    } finally {
      restoreEnv(original)
      await token.cleanup()
    }
  })

  test("stale public command guard throws before prompt execution", async () => {
    const hooks = await plugin({ directory: process.cwd() } as never, {})
    const planOutput = { parts: [{ type: "text", text: "stale prompt" }] }
    const defineOutput = { parts: [{ type: "text", text: "stale prompt" }] }

    await expect(hooks["command.execute.before"]?.({ command: "ralph-plan", sessionID: "s", arguments: "5" }, planOutput as never)).rejects.toThrow(
      "OpenRalph TUI menu",
    )
    await expect(hooks["command.execute.before"]?.({ command: "ralph-define", sessionID: "s", arguments: "idea" }, defineOutput as never)).rejects.toThrow(
      "OpenRalph TUI menu",
    )

    expect(planOutput.parts).toEqual([])
    expect(defineOutput.parts).toEqual([])
  })
})

function captureEnv(): Record<string, string | undefined> {
  return {
    OPENRALPH_IN_DOCKER: process.env.OPENRALPH_IN_DOCKER,
    OPENRALPH_DOCKER_TOKEN: process.env.OPENRALPH_DOCKER_TOKEN,
    OPENRALPH_LOOP_CHILD: process.env.OPENRALPH_LOOP_CHILD,
    OPENRALPH_HOST_LOOP_TOKEN: process.env.OPENRALPH_HOST_LOOP_TOKEN,
    OPENRALPH_HOST_LOOP_TOKEN_FILE: process.env.OPENRALPH_HOST_LOOP_TOKEN_FILE,
    OPENRALPH_OPTIONS_JSON: process.env.OPENRALPH_OPTIONS_JSON,
  }
}

function clearOpenRalphEnv(): void {
  for (const key of Object.keys(captureEnv())) delete process.env[key]
}

function applyEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
