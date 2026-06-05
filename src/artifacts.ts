import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { LoopPhase } from "./args.ts"
import type { CommandOutputEvent, CommandResult } from "./exec.ts"
import { createTimestampId } from "./tags.ts"

export interface CreateRunArtifactsInput {
  projectRoot: string
  phase: LoopPhase
  rawArgs: string
  date?: Date
}

export interface RunArtifacts {
  phase: LoopPhase
  timestampId: string
  runName: string
  dir: string
  logPath: string
}

export interface IterationArtifacts {
  index: number
  jsonlPath: string
  textPath: string
  recordOutput: (event: CommandOutputEvent) => void
  finish: (outcome: IterationOutcome) => Promise<void>
}

export interface IterationOutcome {
  result?: Pick<CommandResult, "exitCode" | "signal">
  status?: string
  error?: unknown
  sentinel?: string
}

export interface RunArtifactSummary {
  phase: LoopPhase
  status: string
  message: string
  launched: number
  tagged: number
  blocked: number
  warnings: string[]
}

export async function createRunArtifacts(input: CreateRunArtifactsInput): Promise<RunArtifacts> {
  const timestampId = createTimestampId(input.date)
  const runsDir = join(input.projectRoot, "runs")
  await mkdir(runsDir, { recursive: true })
  await ensureRunsIgnored(runsDir)

  const runName = createRunArtifactName(input.phase, timestampId)
  const dir = join(runsDir, runName)
  const logPath = join(dir, "ralph.log")
  const run: RunArtifacts = { phase: input.phase, timestampId, runName, dir, logPath }

  await mkdir(dir, { recursive: true })
  await appendRunLog(run, [
    `OpenRalph ${input.phase} run started`,
    `time: ${(input.date ?? new Date()).toISOString()}`,
    `project: ${input.projectRoot}`,
    `args: ${input.rawArgs.trim() || "(default)"}`,
    "",
  ])

  return run
}

export function createRunArtifactName(phase: LoopPhase, timestampId: string): string {
  return `openralph-${phase}-${timestampId}`
}

export async function startIterationArtifacts(run: RunArtifacts, index: number, childArgs: string[]): Promise<IterationArtifacts> {
  const iteration = formatIteration(index)
  const jsonlPath = join(run.dir, `${iteration}.jsonl`)
  const textPath = join(run.dir, `${iteration}.txt`)
  let queue = Promise.resolve()
  let writeError: unknown

  await writeFile(jsonlPath, "")
  await writeFile(textPath, "")
  await appendRunLog(run, [
    `${iteration} started`,
    `time: ${new Date().toISOString()}`,
    `command: opencode ${childArgs.map(quoteArg).join(" ")}`,
    "",
  ])

  const enqueue = (write: () => Promise<void>) => {
    queue = queue.then(write, write).catch((error) => {
      writeError ??= error
    })
  }

  return {
    index,
    jsonlPath,
    textPath,
    recordOutput: (event) => {
      const entry = JSON.stringify({
        time: new Date().toISOString(),
        iteration: index,
        type: "output",
        stream: event.stream,
        chunk: event.chunk,
      })

      enqueue(async () => {
        await appendFile(jsonlPath, `${entry}\n`)
        await appendFile(textPath, event.chunk)
      })
    },
    finish: async (outcome) => {
      await queue
      if (writeError) throw writeError

      await appendRunLog(run, [
        `${iteration} finished`,
        `time: ${new Date().toISOString()}`,
        `status: ${formatOutcomeStatus(outcome)}`,
        ...(outcome.sentinel ? [`sentinel: ${outcome.sentinel}`] : []),
        "",
      ])
    },
  }
}

export async function finishRunArtifacts(run: RunArtifacts, summary: RunArtifactSummary): Promise<void> {
  await appendRunLog(run, [
    `OpenRalph ${summary.phase} run finished`,
    `time: ${new Date().toISOString()}`,
    `status: ${summary.status}`,
    `message: ${summary.message}`,
    `launched iterations: ${summary.launched}`,
    ...(summary.phase === "build" ? [`tagged iterations: ${summary.tagged}`, `blocked iterations: ${summary.blocked}`] : []),
    ...summary.warnings,
    "",
  ])
}

async function ensureRunsIgnored(runsDir: string): Promise<void> {
  const ignorePath = join(runsDir, ".gitignore")
  const ignoreAll = "*"

  try {
    const current = await readFile(ignorePath, "utf8")
    if (current.split(/\r?\n/).some((line) => line.trim() === ignoreAll)) return
    await appendFile(ignorePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${ignoreAll}\n`)
  } catch (error) {
    if (!isNotFound(error)) throw error
    await writeFile(ignorePath, `${ignoreAll}\n`)
  }
}

async function appendRunLog(run: RunArtifacts, lines: string[]): Promise<void> {
  await appendFile(run.logPath, `${lines.join("\n")}\n`)
}

function formatIteration(index: number): string {
  return `iter-${String(index).padStart(3, "0")}`
}

function formatOutcomeStatus(outcome: IterationOutcome): string {
  if (outcome.error) return `error: ${formatError(outcome.error)}`
  if (outcome.status) return outcome.status
  if (!outcome.result) return "unknown"
  if (outcome.result.exitCode === 0) return "exit 0"
  return outcome.result.exitCode === null ? `signal ${outcome.result.signal ?? "unknown"}` : `exit ${outcome.result.exitCode}`
}

function quoteArg(arg: string): string {
  if (/^[^\s"'\\]+$/.test(arg)) return arg
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
