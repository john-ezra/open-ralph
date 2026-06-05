import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"
import { validateOptions, type OpenRalphOptions } from "./args.ts"
import { authorizeLoopChild } from "./trust.ts"

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(pluginDir, "..")
const ORCHESTRATOR_AGENT = "openralph-orchestrator"

export default (async ({ directory }, rawOptions) => {
  validateOptions(rawOptions)

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      delete cfg.command["ralph-define"]
      delete cfg.command["ralph-plan"]
      delete cfg.command["ralph-build"]
      if (cfg.agent) delete cfg.agent[ORCHESTRATOR_AGENT]

      if (await authorizeLoopChild(process.env, directory)) {
        cfg.command["ralph-plan-iteration"] = {
          description: "Run one Ralph planning iteration",
          template: readPrompt("PROMPT_plan.md"),
        }
        cfg.command["ralph-build-iteration"] = {
          description: "Run one Ralph build iteration",
          template: readPrompt("PROMPT_build.md"),
        }
      }
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "ralph-define" && input.command !== "ralph-plan" && input.command !== "ralph-build") return
      output.parts = []
      throw new Error(
        `/${input.command} has been replaced by the OpenRalph TUI menu. Remove any stale prompt-backed ${input.command} command file/config, load the OpenRalph TUI plugin, and run /ralph instead.`,
      )
    },
  }
}) satisfies Plugin

function readPrompt(fileName: string): string {
  try {
    return readFileSync(resolve(packageRoot, fileName), "utf8")
  } catch (error) {
    throw new Error(`OpenRalph could not read bundled prompt ${fileName}; the package may be installed incompletely: ${formatError(error)}`)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { OpenRalphOptions }
