import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseLoopArgs, resolveModel, type LoopPhase, type OpenRalphOptions } from "./args.ts"
import { createRunArtifacts, finishRunArtifacts, startIterationArtifacts } from "./artifacts.ts"
import { startCommand, type CommandOutputEvent, type CommandResult } from "./exec.ts"
import {
  requireGitContext,
  getHead,
  isWorktreeClean,
  createLightweightTag,
  pushCurrentBranch,
  readGitInfoExclude,
  readWorktreeStatus,
  hasPathChanges,
  commitPath,
} from "./git.ts"
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
  heartbeatIntervalMs?: number
}

export interface LoopSummary {
  phase: LoopPhase
  status: "complete" | "max-reached" | "failed" | "stopped" | "blocked"
  message: string
  launched: number
  tagged: number
  blocked: number
  warnings: string[]
  artifacts: string
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const IMPLEMENTATION_PLAN_PATH = "IMPLEMENTATION_PLAN.md"

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
    consecutiveBlocked: 0,
    consecutiveFailures: 0,
    lastFailure: undefined as string | undefined,
    stopRequested: false,
    forceStopRequested: false,
    activeChild: undefined as ReturnType<typeof startCommand>["child"] | undefined,
    activeHeartbeat: undefined as ChildHeartbeat | undefined,
  }

  const runId = input.phase === "build" ? artifacts.timestampId : undefined
  const finish = async (status: LoopSummary["status"], message: string): Promise<LoopSummary> => {
    const result = summary(input.phase, status, message, state, warnings, artifacts.dir)
    await finishRunArtifacts(artifacts, result)
    return result
  }

  if (input.phase === "build") {
    const statusLines = await readWorktreeStatus(git.root)
    if (statusLines.length > 0) return finish("failed", formatBuildDirtyPreflightMessage(statusLines))
  }

  const requestStop = (force: boolean, announce: boolean) => {
    if (!state.stopRequested) {
      state.stopRequested = true
      state.activeChild?.kill("SIGINT")
      state.activeHeartbeat?.stop()
      state.activeHeartbeat = undefined
      if (!force && announce) process.stderr.write("\nOpenRalph stop requested. Waiting for active child to exit...\n")
      return
    }

    if (force) {
      state.forceStopRequested = true
      state.activeChild?.kill("SIGKILL")
      state.activeHeartbeat?.stop()
      state.activeHeartbeat = undefined
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
      const beforeImplementationPlan = input.phase === "plan" ? await readImplementationPlanSnapshot(git.root) : undefined
      const childArgs = buildChildArgs(input.phase, git.root, model)
      if (state.stopRequested || input.signal?.aborted) {
        return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
      }
      state.launched += 1
      const iterationArtifacts = await startIterationArtifacts(artifacts, state.launched, childArgs)

      let result: CommandResult | undefined
      let childError: unknown
      let activeChild: ReturnType<typeof startCommand>["child"] | undefined
      let heartbeat: ChildHeartbeat | undefined
      const stopHeartbeat = () => {
        heartbeat?.stop()
        if (state.activeHeartbeat === heartbeat) state.activeHeartbeat = undefined
      }

      try {
        const child = startCommand("opencode", childArgs, {
          cwd: git.root,
          env: loopChild.env,
          streamOutput,
          onOutput: (event) => {
            heartbeat?.recordOutput()
            iterationArtifacts.recordOutput(event)
            input.onOutput?.(event)
          },
          signal: input.signal,
        })
        activeChild = child.child
        state.activeChild = child.child
        if (state.stopRequested || input.signal?.aborted) {
          child.child.kill(state.forceStopRequested ? "SIGKILL" : "SIGINT")
        }
        child.child.once("spawn", () => {
          if (state.activeChild !== child.child || state.stopRequested || input.signal?.aborted) return
          heartbeat = startChildHeartbeat({
            phase: input.phase,
            iteration: state.launched,
            intervalMs: input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
            streamOutput,
            onOutput: input.onOutput,
          })
          state.activeHeartbeat = heartbeat
        })
        result = await child.result
      } catch (error) {
        childError = error
      } finally {
        stopHeartbeat()
        if (state.activeChild === activeChild) state.activeChild = undefined
      }

      if (childError !== undefined) {
        await iterationArtifacts.finish({ error: childError })
        if (state.stopRequested || state.forceStopRequested || input.signal?.aborted) {
          return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
        }

        const failed = recordFailure(input.phase, state, `child process failed to start: ${formatError(childError)}`, streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }

      if (result === undefined) {
        await iterationArtifacts.finish({ error: "child process ended without a result" })
        const failed = recordFailure(input.phase, state, "child process ended without a result", streamOutput)
        if (failed) return finish("failed", failed)
        continue
      }

      // Sentinels are read from stdout only; stderr carries heartbeat/diagnostic
      // lines and must never satisfy or spoof a completion sentinel.
      const sentinelOutput = result.stdout

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
        const planComplete = isPlanComplete(sentinelOutput)
        const planChanged = beforeImplementationPlan !== (await readImplementationPlanSnapshot(git.root))
        const acceptsCompletion = planComplete && !planChanged
        const status = planComplete && planChanged ? "planning continues; plan changed during iteration" : planComplete ? "planning complete" : "planning continues"
        await iterationArtifacts.finish({ result, status, sentinel: planComplete ? "RALPH_PLAN_COMPLETE" : undefined })
        if (acceptsCompletion) {
          state.consecutiveFailures = 0
          state.lastFailure = undefined
          let planCommitted = false
          try {
            planCommitted = await commitImplementationPlanIfChanged(git.root)
          } catch (error) {
            return finish("failed", `planning complete but failed to commit ${IMPLEMENTATION_PLAN_PATH}: ${formatError(error)}`)
          }

          await warnIfDirtyAfterPlanning(git.root, warnings, streamOutput)
          return finish("complete", planCommitted ? `planning complete; committed ${IMPLEMENTATION_PLAN_PATH}` : "planning complete")
        }

        if (planChanged) {
          state.consecutiveFailures = 0
          state.lastFailure = undefined
          continue
        }

        // A clean exit that neither printed the sentinel nor changed the plan is
        // no progress; without backpressure an idle model loops forever.
        const failed = recordFailure(
          input.phase,
          state,
          `plan child exited successfully without printing RALPH_PLAN_COMPLETE or changing ${IMPLEMENTATION_PLAN_PATH}`,
          streamOutput,
        )
        if (failed) return finish("failed", failed)
        continue
      }

      const sentinel = detectBuildSentinel(sentinelOutput)
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
        const afterHead = await getHead(git.root)
        state.consecutiveBlocked = afterHead && afterHead !== beforeHead ? 1 : state.consecutiveBlocked + 1
        if (state.consecutiveBlocked >= 3) {
          return finish(
            "blocked",
            "stopped after 3 consecutive blocked iterations without new commits; resolve the blocker documented in IMPLEMENTATION_PLAN.md and rerun",
          )
        }
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
      state.consecutiveBlocked = 0
    }

    return finish("stopped", `stopped by user after ${state.launched} launched iteration(s)`)
  } finally {
    state.activeHeartbeat?.stop()
    state.activeHeartbeat = undefined
    process.off("SIGINT", onSigint)
    input.signal?.removeEventListener("abort", onAbort)
    await loopChild.cleanup()
  }
}

async function readImplementationPlanSnapshot(projectRoot: string): Promise<string | undefined> {
  try {
    return await readFile(join(projectRoot, IMPLEMENTATION_PLAN_PATH), "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

interface ChildHeartbeat {
  recordOutput: () => void
  stop: () => void
}

function startChildHeartbeat(input: {
  phase: LoopPhase
  iteration: number
  intervalMs: number
  streamOutput: boolean
  onOutput?: (event: CommandOutputEvent) => void
}): ChildHeartbeat {
  if (!input.streamOutput && !input.onOutput) {
    return { recordOutput: () => {}, stop: () => {} }
  }

  const intervalMs = Number.isFinite(input.intervalMs) && input.intervalMs > 0 ? input.intervalMs : DEFAULT_HEARTBEAT_INTERVAL_MS
  const iteration = formatIteration(input.iteration)
  const startedAt = Date.now()
  let lastOutputAt = startedAt
  let stopped = false

  const emit = (message: string) => {
    const chunk = `${message}\n`
    if (input.streamOutput) process.stderr.write(chunk)
    input.onOutput?.({ stream: "stderr", chunk })
  }

  emit(`OpenRalph ${input.phase} ${iteration} started. Waiting for opencode output...`)

  const timer = setInterval(() => {
    if (stopped) return
    const now = Date.now()
    const quietMs = now - lastOutputAt
    if (quietMs < intervalMs) return

    emit(
      `OpenRalph ${input.phase} ${iteration} still running after ${formatDuration(now - startedAt)} (${formatDuration(quietMs)} since last output).`,
    )
  }, intervalMs)
  timer.unref?.()

  return {
    recordOutput: () => {
      lastOutputAt = Date.now()
    },
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}

async function commitImplementationPlanIfChanged(projectRoot: string): Promise<boolean> {
  if (!(await hasPathChanges(projectRoot, IMPLEMENTATION_PLAN_PATH))) return false
  await commitPath(projectRoot, IMPLEMENTATION_PLAN_PATH, "Update implementation plan")
  return true
}

async function warnIfDirtyAfterPlanning(projectRoot: string, warnings: string[], streamOutput: boolean): Promise<void> {
  const statusLines = await readWorktreeStatus(projectRoot)
  if (statusLines.length === 0) return

  const warning = [
    "warning: worktree remains dirty after planning; Build will fail until these paths are committed, ignored, stashed, or removed:",
    ...statusLines.slice(0, 12).map((line) => `  ${line}`),
    ...(statusLines.length > 12 ? [`  ...and ${statusLines.length - 12} more`] : []),
  ].join("\n")
  warnings.push(warning)
  if (streamOutput) process.stderr.write(`OpenRalph ${warning}\n`)
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

function formatIteration(index: number): string {
  return `iter-${String(index).padStart(3, "0")}`
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function hostModeWarning(mode: LoopExecutionMode | undefined): string | undefined {
  if (mode === "container-attested") return undefined
  if (mode === "host-explicit") {
    return "warning: --no-docker selected; child iterations run on the host with --dangerously-skip-permissions"
  }
  return "warning: host mode runs child iterations on this machine with --dangerously-skip-permissions"
}

export function formatBuildDirtyPreflightMessage(statusLines: string[]): string {
  const lines = [
    "Build requires a clean Git worktree before starting.",
    "Commit, stash, remove, or ignore existing changes before rerunning OpenRalph Build.",
  ]

  if (hasOpenCodeConfigStatus(statusLines)) {
    lines.push("Local .opencode/ plugin config is dirty; commit it, add it to .gitignore, remove it, or use a global plugin install.")
  }

  lines.push("Dirty paths:", ...statusLines.slice(0, 12).map((line) => `  ${line}`))
  if (statusLines.length > 12) lines.push(`  ...and ${statusLines.length - 12} more`)
  return lines.join("\n")
}

function hasOpenCodeConfigStatus(statusLines: string[]): boolean {
  return statusLines.some((line) => /(^| )\.opencode(\/|$)/.test(line) || / -> \.opencode(\/|$)/.test(line))
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
}
