import { formatLoopArgsForReplay, parseLoopArgs, resolveDockerOptions, validateOptions, type LoopPhase, type OpenRalphOptions, type ParsedLoopArgs } from "./args.ts"
import { CONTAINER_WORKSPACE, dockerImageExists as defaultDockerImageExists, runDockerLoop } from "./docker.ts"
import { commandExists as defaultCommandExists, type CommandOutputEvent, type CommandResult } from "./exec.ts"
import { requireGitContext } from "./git.ts"
import { formatSummary, runLoop, type LoopSummary } from "./loop.ts"
import { attestDockerEnvironment, hasDockerMarker, type TrustDeps } from "./trust.ts"

export type LauncherMode = "docker-host-launch" | "host-explicit" | "host-config-default" | "container-attested"

export interface RunLauncherInput {
  phase: LoopPhase
  rawArgs: string
  cwd: string
  options: OpenRalphOptions
  streamOutput?: boolean
  captureOutput?: boolean
  onOutput?: (event: CommandOutputEvent) => void
  signal?: AbortSignal
}

export interface LauncherResult {
  phase: LoopPhase
  mode: LauncherMode
  status: LoopSummary["status"]
  summary: string
  outputTail?: string
}

export interface RunLauncherDeps {
  env?: NodeJS.ProcessEnv
  requireGitContext?: typeof requireGitContext
  runDockerLoop?: typeof runDockerLoop
  runLoop?: typeof runLoop
  commandExists?: typeof defaultCommandExists
  dockerImageExists?: typeof defaultDockerImageExists
  trust?: TrustDeps
}

export interface ResolveLauncherModeInput {
  parsed: ParsedLoopArgs
  options: OpenRalphOptions
  env?: NodeJS.ProcessEnv
  trust?: TrustDeps
}

export async function runOpenRalphLauncher(input: RunLauncherInput, deps: RunLauncherDeps = {}): Promise<LauncherResult> {
  const parsed = parseLoopArgs(input.phase, input.rawArgs)
  const mode = await resolveLauncherMode({ parsed, options: input.options, env: deps.env, trust: deps.trust })

  if (mode === "docker-host-launch") {
    if (input.phase === "build" && parsed.push) {
      throw new Error("OpenRalph Build --push is not supported in Docker mode. Run without --push, review the local commits, then push from the host.")
    }
  }

  await preflightCommands(mode, deps.commandExists ?? defaultCommandExists)

  if (mode === "docker-host-launch") {
    const docker = resolveDockerOptions(input.options)
    const imageExists = await (deps.dockerImageExists ?? defaultDockerImageExists)(docker.image, input.cwd)
    if (!imageExists) throw new Error(formatMissingDockerImage(input.phase, parsed, docker.image))

    const git = await (deps.requireGitContext ?? requireGitContext)(input.cwd)
    const result = await (deps.runDockerLoop ?? runDockerLoop)({
      phase: input.phase,
      rawArgs: input.rawArgs,
      projectRoot: git.root,
      options: input.options,
      streamOutput: input.streamOutput,
      captureOutput: input.captureOutput,
      onOutput: input.onOutput,
      signal: input.signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(formatDockerFailure(input.phase, parsed, result))
    }

    const output = commandOutput(result)
    const displayOutput = translateContainerPaths(output, git.root) ?? ""
    const innerSummary = translateContainerPaths(extractOpenRalphSummary(input.phase, output), git.root)
    if (innerSummary?.startsWith(`OpenRalph ${input.phase} failed:`)) {
      throw new Error(formatDockerInnerFailure(input.phase, innerSummary))
    }

    return {
      phase: input.phase,
      mode,
      status: "complete",
      summary: formatDockerSuccess(input.phase, result, git.root),
      outputTail: displayOutput ? tailLines(displayOutput, 80) : undefined,
    }
  }

  const loopSummary = await (deps.runLoop ?? runLoop)({
    phase: input.phase,
    rawArgs: input.rawArgs,
    cwd: input.cwd,
    options: input.options,
    executionMode: mode,
    streamOutput: input.streamOutput,
    onOutput: input.onOutput,
    signal: input.signal,
  })

  return {
    phase: input.phase,
    mode,
    status: loopSummary.status,
    summary: formatSummary(loopSummary),
  }
}

export async function resolveLauncherMode(input: ResolveLauncherModeInput): Promise<LauncherMode> {
  const env = input.env ?? process.env
  const docker = resolveDockerOptions(input.options)

  if (await hasDockerMarker(env, input.trust)) {
    if (!(await attestDockerEnvironment(env, input.trust))) {
      throw new Error("OpenRalph Docker attestation failed. Refusing to run a loop with untrusted Docker markers or token state.")
    }
    return "container-attested"
  }

  if (docker.enabled && !input.parsed.noDocker) return "docker-host-launch"
  if (input.parsed.noDocker) return "host-explicit"
  return "host-config-default"
}

export function readOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OpenRalphOptions {
  const raw = env.OPENRALPH_OPTIONS_JSON
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`OPENRALPH_OPTIONS_JSON must be valid JSON: ${formatError(error)}`)
  }

  return validateOptions(parsed)
}

export function formatDockerSuccess(phase: LoopPhase, result: CommandResult, projectRoot?: string): string {
  const output = translateContainerPaths(commandOutput(result), projectRoot) ?? ""
  const summary = extractOpenRalphSummary(phase, output)
  const lines = [`OpenRalph ${phase} Docker execution completed.`]

  if (summary) {
    lines.push("", summary)
  } else if (output) {
    lines.push("", "Container output tail:", tailLines(output, 80))
  }

  return lines.join("\n")
}

export function formatDockerInnerFailure(phase: LoopPhase, summary: string): string {
  return [
    `OpenRalph Docker execution finished, but the ${phase} loop reported failure.`,
    "",
    summary,
    "",
    "Review the worktree before rerunning; the failed child may have left partial changes.",
  ].join("\n")
}

export function formatDockerFailure(phase: LoopPhase, parsed: ParsedLoopArgs, result: CommandResult): string {
  const reason = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.exitCode}`
  const output = commandOutput(result)
  const lines = [
    `OpenRalph Docker execution failed: Docker exited with ${reason}`,
    "",
    "OpenRalph did not fall back to host execution because Docker mode is enabled.",
    "Fix the Docker issue and rerun the command.",
    "",
    "If you intentionally want to run this loop on the host, rerun with:",
    `  ${noDockerCommand(phase, parsed)}`,
  ]

  if (output) lines.push("", "Container output tail:", tailLines(output, 80))
  return lines.join("\n")
}

async function preflightCommands(mode: LauncherMode, exists: typeof defaultCommandExists): Promise<void> {
  const required = mode === "docker-host-launch" ? ["git", "docker"] : ["git", "opencode"]
  const missing: string[] = []

  for (const command of required) {
    if (!(await exists(command))) missing.push(command)
  }

  if (missing.length > 0) throw new Error(formatMissingCommands(missing))
}

function formatMissingCommands(commands: string[]): string {
  const hints: Record<string, string> = {
    git: "Install git and ensure it is on PATH.",
    opencode: "Install opencode (https://opencode.ai) and ensure it is on PATH.",
    docker: "Install Docker and ensure the docker executable is on PATH, or run this loop with --no-docker to opt into host mode.",
  }

  return [
    `OpenRalph required command${commands.length === 1 ? "" : "s"} not found on PATH: ${commands.join(", ")}.`,
    ...commands.map((command) => `${command}: ${hints[command] ?? "Install it and ensure it is on PATH."}`),
  ].join("\n")
}

function formatMissingDockerImage(phase: LoopPhase, parsed: ParsedLoopArgs, image: string): string {
  return [
    `Docker image ${image} was not found.`,
    "",
    "OpenRalph defaults to Docker mode for safer loop execution and Docker runs with --pull=never.",
    "Build the local image with:",
    "  bunx @john-ezra/openralph docker build",
    "",
    "If you intentionally want to run this loop on the host, rerun with:",
    `  ${noDockerCommand(phase, parsed)}`,
  ].join("\n")
}

function noDockerCommand(phase: LoopPhase, parsed: ParsedLoopArgs): string {
  const replayArgs = formatLoopArgsForReplay(parsed)
  return `openralph ${phase}${replayArgs ? ` ${replayArgs}` : ""} --no-docker`
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim()
}

function translateContainerPaths(value: string | undefined, projectRoot: string | undefined): string | undefined {
  if (!value || !projectRoot) return value
  return value.split(`${CONTAINER_WORKSPACE}/runs/`).join(`${projectRoot}/runs/`)
}

function extractOpenRalphSummary(phase: LoopPhase, output: string): string | undefined {
  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(`OpenRalph ${phase} `)) {
      return lines.slice(index, Math.min(lines.length, index + 8)).join("\n").trim()
    }
  }
  return undefined
}

function tailLines(input: string, maxLines: number): string {
  const lines = input.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
