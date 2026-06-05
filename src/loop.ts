import { parseLoopArgs, resolveModel, type LoopPhase, type OpenRalphOptions } from "./args.ts"
import { createRunArtifacts, finishRunArtifacts, startIterationArtifacts } from "./artifacts.ts"
import { startCommand, type CommandOutputEvent, type CommandResult } from "./exec.ts"
import { requireGitContext, getHead, isWorktreeClean, createLightweightTag, pushCurrentBranch, readGitInfoExclude } from "./git.ts"
import { detectBuildSentinel, isPlanComplete } from "./sentinels.ts"
import { createBuildTagName } from "./tags.ts"
import { createHostLoopToken } from "./trust.ts"

export type LoopExecutionMode = "host-explicit" | "host-config-default" | "container-attested"

export interface RunLoopInput {
  phase: LoopPhase
  rawArgs: string
  cwd: string
  options: OpenRalphOptions
  executionMode?: LoopExecutionMode
  streamOutput?: boolean
  onOutput?: (event: CommandOutputEvent) => void
  signal?: AbortSignal
}

export interface LoopSummary {
  phase: LoopPhase
  status: "complete" | "max-reached" | "failed" | "stopped"
  message: string
  launched: number
  tagged: number
  blocked: number
  warnings: string[]
  artifacts: string
}

export async function runLoop(input: RunLoopInput): Promise<LoopSummary> {
  const args = parseLoopArgs(input.phase, input.rawArgs)
  const model = resolveModel(input.phase, args, input.options)
  const git = await requireGitContext(input.cwd)
  const streamOutput = input.streamOutput ?? true
  const warnings: string[] = []
  const artifacts = await createRunArtifacts({ projectRoot: git.root, phase: input.phase, rawArgs: input.rawArgs })

  if (git.branch === "main" || git.branch === "master") {
    const warning = `warning: running OpenRalph on ${git.branch}`
    warnings.push(warning)
    if (streamOutput) process.stderr.write(`OpenRalph ${warning}\n`)
  }

  const hostWarning = hostModeWarning(input.executionMode)
  if (hostWarning) {
    warnings.push(hostWarning)
    if (streamOutput) process.stderr.write(`OpenRalph ${hostWarning}\n`)
  }

  const state = {
    launched: 0,
    tagged: 0,
    blocked: 0,
    consecutiveFailures: 0,
    lastFailure: undefined as string | undefined,
    stopRequested: false,
    forceStopRequested: false,
    activeChild: undefined as ReturnType<typeof startCommand>["child"] | undefined,
  }

  const requestStop = (force: boolean, announce: boolean) => {
    if (!state.stopRequested) {
      state.stopRequested = true
      state.activeChild?.kill("SIGINT")
      if (!force && announce) process.stderr.write("\nOpenRalph stop requested. Waiting for active child to exit...\n")
      return
    }

    if (force) {
      state.forceStopRequested = true
      state.activeChild?.kill("SIGKILL")
      if (announce) process.stderr.write("\nOpenRalph force stop requested. Terminating active child...\n")
    }
  }

  const onSigint = () => {
    requestStop(state.stopRequested, true)
  }

  const onAbort = () => requestStop(false, false)

  const loopChild = await buildLoopChildEnv(input.executionMode)
  process.on("SIGINT", onSigint)
  if (input.signal?.aborted) onAbort()
  else input.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const runId = input.phase === "build" ? artifacts.timestampId : undefined

    const finish = async (status: LoopSummary["status"], message: string): Promise<LoopSummary> => {
      const result = summary(input.phase, status, message, state, warnings, artifacts.dir)
      await finishRunArtifacts(artifacts, result)
      return result
    }

    const tagCleanBuildCommit = async (dirtyMessage: string): Promise<LoopSummary | undefined> => {
      if (!(await isWorktreeClean(git.root))) {
        return finish("failed", dirtyMessage)
      }

      const tagName = createBuildTagName(runId ?? artifacts.timestampId, state.tagged + 1)
      let tagged = false
      try {
        await createLightweightTag(git.root, tagName)
        state.tagged += 1
        tagged = true
      } catch (error) {
        const warning = `warning: failed to tag build commit (${tagName}): ${formatError(error)}`
        warnings.push(warning)
        if (streamOutput) process.stderr.write(`OpenRalph ${warning}\n`)
      }

      if (args.push) {
        try {
          await pushCurrentBranch(git.root, git.branch)
        } catch (error) {
          const tagStatus = tagged ? " and is tagged locally" : ""
          return finish(
            "failed",
            `build commit succeeded${tagStatus}, but pushing ${git.branch} failed: ${formatError(error)}. Push manually from the host.`,
          )
        }
      }

      return undefined
    }

    while (!state.stopRequested) {
      if (args.maxIterations !== undefined && state.launched >= args.maxIterations) {
        if (state.consecutiveFailures > 0) {
          return finish("failed", `reached max iterations (${args.maxIterations}) after a failed child; last failure: ${state.lastFailure}`)
        }
        return finish("max-reached", `reached max iterations (${args.maxIterations})`)
      }

      const beforeHead = input.phase === "build" ? await getHead(git.root) : undefined
      const beforeGitInfoExclude = input.phase === "build" ? await readGitInfoExclude(git.root) : undefined
      const childArgs = buildChildArgs(input.phase, git.root, model)
      state.launched += 1
      const iterationArtifacts = await startIterationArtifacts(artifacts, state.launched, childArgs)

      let result: CommandResult
      try {
        const child = startCommand("opencode", childArgs, {
          cwd: git.root,
          env: loopChild.env,
          streamOutput,
          onOutput: (event) => {
            iterationArtifacts.recordOutput(event)
            input.onOutput?.(event)
          },
          signal: input.signal,
        })
        state.activeChild = child.child
        result = await child.result
      } catch (error) {
        state.activeChild = undefined
        await iterationArtifacts.finish({ error })
        if (state.stopRequested || state.forceStopRequested || input.signal?.aborted) {
          return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
        }

        const failed = recordFailure(input.phase, state, `child process failed to start: ${formatError(error)}`, streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }
      state.activeChild = undefined

      const output = `${result.stdout}\n${result.stderr}`

      if (state.stopRequested || state.forceStopRequested || input.signal?.aborted) {
        await iterationArtifacts.finish({ result, status: "stopped by user" })
        return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
      }

      if (result.exitCode !== 0) {
        await iterationArtifacts.finish({ result, status: "child process failed" })
        const failed = recordFailure(input.phase, state, `child process failed with exit code ${result.exitCode ?? `signal ${result.signal}`}`, streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }

      if (input.phase === "plan") {
        const planComplete = isPlanComplete(output)
        await iterationArtifacts.finish({ result, status: planComplete ? "planning complete" : "planning continues", sentinel: planComplete ? "RALPH_PLAN_COMPLETE" : undefined })
        state.consecutiveFailures = 0
        state.lastFailure = undefined
        if (planComplete) {
          return finish("complete", "planning complete")
        }
        continue
      }

      const sentinel = detectBuildSentinel(output)
      if (beforeGitInfoExclude !== undefined && (await readGitInfoExclude(git.root)) !== beforeGitInfoExclude) {
        await iterationArtifacts.finish({
          result,
          status: "build child modified .git/info/exclude",
          sentinel: sentinel === "none" ? undefined : sentinel,
        })
        return finish(
          "failed",
          "build child modified .git/info/exclude; restore it and use tracked ignore rules or fixture cleanup instead of masking files",
        )
      }
      await iterationArtifacts.finish({ result, status: `build sentinel: ${sentinel}`, sentinel: sentinel === "none" ? undefined : sentinel })
      if (sentinel === "complete") {
        const afterHead = await getHead(git.root)
        if (afterHead && afterHead !== beforeHead) {
          const failed = await tagCleanBuildCommit("build completion reported with a dirty worktree; not tagging")
          if (failed) return failed
        } else if (!(await isWorktreeClean(git.root))) {
          return finish("failed", "build completion reported with a dirty worktree; completed work must be committed before finishing")
        }

        state.consecutiveFailures = 0
        state.lastFailure = undefined
        return finish("complete", "build complete")
      }

      if (sentinel === "blocked") {
        state.consecutiveFailures = 0
        state.lastFailure = undefined
        state.blocked += 1
        continue
      }

      if (sentinel === "none") {
        const failed = recordFailure(input.phase, state, "build child exited successfully without a Ralph sentinel", streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }

      const afterHead = await getHead(git.root)
      if (!afterHead || afterHead === beforeHead) {
        const failed = recordFailure(input.phase, state, "build iteration reported completion but did not create a new commit", streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }

      const failed = await tagCleanBuildCommit("build iteration completed with a dirty worktree; not tagging")
      if (failed) return failed

      state.consecutiveFailures = 0
      state.lastFailure = undefined
    }

    return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
  } finally {
    process.off("SIGINT", onSigint)
    input.signal?.removeEventListener("abort", onAbort)
    await loopChild.cleanup()
  }
}

async function buildLoopChildEnv(executionMode: LoopExecutionMode | undefined): Promise<{
  env: Record<string, string>
  cleanup: () => Promise<void>
}> {
  if (executionMode === "container-attested") {
    return { env: { OPENRALPH_LOOP_CHILD: "1" }, cleanup: async () => {} }
  }

  const hostToken = await createHostLoopToken()
  return {
    env: {
      OPENRALPH_LOOP_CHILD: "1",
      ...hostToken.env,
    },
    cleanup: hostToken.cleanup,
  }
}

function buildChildArgs(phase: LoopPhase, projectRoot: string, model: string | undefined): string[] {
  const args = [
    "run",
    "--dir",
    projectRoot,
    "--command",
    phase === "plan" ? "ralph-plan-iteration" : "ralph-build-iteration",
    "--dangerously-skip-permissions",
  ]

  if (model) args.push("--model", model)
  return args
}

function hostModeWarning(mode: LoopExecutionMode | undefined): string | undefined {
  if (mode === "container-attested") return undefined
  if (mode === "host-explicit") {
    return "warning: --no-docker selected; child iterations run on the host with --dangerously-skip-permissions"
  }
  return "warning: host mode runs child iterations on this machine with --dangerously-skip-permissions"
}

function recordFailure(
  phase: LoopPhase,
  state: { consecutiveFailures: number; lastFailure?: string },
  reason: string,
  streamOutput: boolean,
): string | undefined {
  state.consecutiveFailures += 1
  state.lastFailure = reason
  if (streamOutput) process.stderr.write(`\nOpenRalph ${phase} iteration failed: ${reason}\n`)
  if (state.consecutiveFailures >= 3) {
    return `stopped after 3 consecutive child failures; last failure: ${reason}`
  }
  return undefined
}

function summary(
  phase: LoopPhase,
  status: LoopSummary["status"],
  message: string,
  state: { launched: number; tagged: number; blocked: number },
  warnings: string[],
  artifacts: string,
): LoopSummary {
  return {
    phase,
    status,
    message,
    launched: state.launched,
    tagged: state.tagged,
    blocked: state.blocked,
    warnings,
    artifacts,
  }
}

export function formatSummary(summary: LoopSummary): string {
  const lines = [
    `OpenRalph ${summary.phase} ${summary.status}: ${summary.message}`,
    `launched iterations: ${summary.launched}`,
    `artifacts: ${summary.artifacts}`,
  ]

  if (summary.phase === "build") {
    lines.push(`tagged iterations: ${summary.tagged}`)
    lines.push(`blocked iterations: ${summary.blocked}`)
  }

  for (const warning of summary.warnings) lines.push(warning)
  return lines.join("\n")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
