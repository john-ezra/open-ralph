import { spawn, type ChildProcess } from "node:child_process"

export interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type CommandOutputStream = "stdout" | "stderr"

export interface CommandOutputEvent {
  stream: CommandOutputStream
  chunk: string
}

export interface RunningCommand {
  child: ChildProcess
  result: Promise<CommandResult>
}

export interface StartCommandOptions {
  cwd: string
  env?: Record<string, string | undefined>
  streamOutput?: boolean
  captureOutput?: boolean
  onOutput?: (event: CommandOutputEvent) => void
  signal?: AbortSignal
  abortKillEscalationMs?: number
}

const DEFAULT_ABORT_KILL_ESCALATION_MS = 10_000

export function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return startCommand(command, args, { cwd, streamOutput: false }).result
}

export async function commandExists(command: string, cwd = process.cwd()): Promise<boolean> {
  try {
    await runCommand(command, ["--version"], cwd)
    return true
  } catch (error) {
    return !isMissingCommandError(error)
  }
}

export function startCommand(command: string, args: string[], options: StartCommandOptions): RunningCommand {
  const env = buildEnv(options.env)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const streamOutput = options.streamOutput ?? false
  const captureOutput = options.captureOutput ?? true
  let stdout = ""
  let stderr = ""

  // On abort, ask politely first, then escalate so a child that ignores SIGINT
  // cannot hang the caller (and its embedder) forever.
  let escalationTimers: ReturnType<typeof setTimeout>[] = []
  const clearEscalation = () => {
    for (const timer of escalationTimers) clearTimeout(timer)
    escalationTimers = []
  }
  const abort = () => {
    child.kill("SIGINT")
    const graceMs = options.abortKillEscalationMs ?? DEFAULT_ABORT_KILL_ESCALATION_MS
    if (graceMs > 0 && escalationTimers.length === 0) {
      escalationTimers = [
        setTimeout(() => child.kill("SIGTERM"), graceMs),
        setTimeout(() => child.kill("SIGKILL"), graceMs * 2),
      ]
      for (const timer of escalationTimers) timer.unref?.()
    }
  }
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")

  child.stdout.on("data", (chunk: string) => {
    if (captureOutput) stdout += chunk
    options.onOutput?.({ stream: "stdout", chunk })
    if (streamOutput) process.stdout.write(chunk)
  })
  child.stderr.on("data", (chunk: string) => {
    if (captureOutput) stderr += chunk
    options.onOutput?.({ stream: "stderr", chunk })
    if (streamOutput) process.stderr.write(chunk)
  })

  const result = new Promise<CommandResult>((resolve, reject) => {
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", abort)
      clearEscalation()
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", abort)
      clearEscalation()
      resolve({ exitCode, signal, stdout, stderr })
    })
  })

  return { child, result }
}

function buildEnv(overrides: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!overrides) return env

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }

  return env
}

function isMissingCommandError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
