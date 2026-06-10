import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { formatLoopArgsForReplay, parseLoopArgs, resolveDockerOptions, validateOptions, type LoopPhase, type OpenRalphOptions, type ParsedLoopArgs } from "./args.ts"
import {
  CONTAINER_WORKSPACE,
  inspectDockerImage as defaultInspectDockerImage,
  pullDockerImage as defaultPullDockerImage,
  readOpenRalphPackageVersion as defaultReadPackageVersion,
  resolveRuntimeDockerOptions,
  runDockerLoop,
} from "./docker.ts"
import { commandExists as defaultCommandExists, type CommandOutputEvent, type CommandResult } from "./exec.ts"
import { requireGitContext, readWorktreeStatus as defaultReadWorktreeStatus } from "./git.ts"
import { formatBuildDirtyPreflightMessage, formatSummary, runLoop, type LoopSummary } from "./loop.ts"
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
  inspectDockerImage?: typeof defaultInspectDockerImage
  pullDockerImage?: typeof defaultPullDockerImage
  readPackageVersion?: typeof defaultReadPackageVersion
  readWorktreeStatus?: typeof defaultReadWorktreeStatus
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
  const env = deps.env ?? process.env
  // OPENRALPH_OPTIONS_JSON is the complete intended config when set (CLI and
  // container runs); otherwise fall back to the project's opencode.json plugin
  // entry so server-side options are honored, with caller options winning per key.
  const projectOptions = env.OPENRALPH_OPTIONS_JSON
    ? {}
    : await readProjectPluginOptions(input.cwd, (warning) => emitLauncherStatus(input, `${warning}\n`))
  const options = mergeOptions(projectOptions, input.options)
  const mode = await resolveLauncherMode({ parsed, options, env: deps.env, trust: deps.trust })

  if (mode === "docker-host-launch") {
    if (input.phase === "build" && parsed.push) {
      throw new Error("OpenRalph Build --push is not supported in Docker mode. Run without --push, review the local commits, then push from the host.")
    }
  }

  await preflightCommands(mode, deps.commandExists ?? defaultCommandExists)

  if (mode === "docker-host-launch") {
    let git: Awaited<ReturnType<typeof requireGitContext>> | undefined
    if (input.phase === "build") {
      git = await (deps.requireGitContext ?? requireGitContext)(input.cwd)
      const statusLines = await (deps.readWorktreeStatus ?? defaultReadWorktreeStatus)(git.root)
      if (statusLines.length > 0) throw new Error(formatBuildDirtyPreflightMessage(statusLines))
    }

    const expectedVersion = (deps.readPackageVersion ?? defaultReadPackageVersion)()
    const docker = resolveRuntimeDockerOptions(options, expectedVersion)
    const isDefaultImage = options.docker?.image === undefined
    const inspectDockerImage = deps.inspectDockerImage ?? defaultInspectDockerImage
    emitLauncherStatus(input, `OpenRalph checking Docker image ${docker.image}.\n`)
    let imageStatus = await inspectDockerImage(docker.image, input.cwd)

    if (!imageStatus.exists && isDefaultImage) {
      emitLauncherStatus(
        input,
        [
          `OpenRalph preparing Docker image ${docker.image}.`,
          "No run artifacts will be created until the image is ready and the container starts.",
          'First-time pulls can take several minutes; Docker may continue extracting after "Download complete".',
          "",
        ].join("\n"),
      )

      const pullResult = await (deps.pullDockerImage ?? defaultPullDockerImage)({
        image: docker.image,
        cwd: input.cwd,
        streamOutput: input.streamOutput,
        captureOutput: input.captureOutput,
        onOutput: input.onOutput,
        signal: input.signal,
      })
      if (pullResult.exitCode !== 0) throw new Error(formatDockerPullFailure(input.phase, parsed, docker.image, pullResult))
      emitLauncherStatus(input, `OpenRalph Docker image pull completed for ${docker.image}. Verifying image metadata.\n`)
      imageStatus = await inspectDockerImage(docker.image, input.cwd)
    }

    if (!imageStatus.exists) throw new Error(formatMissingDockerImage(input.phase, parsed, docker.image, isDefaultImage))

    if (imageStatus.version !== expectedVersion) {
      throw new Error(formatStaleDockerImage(input.phase, parsed, docker.image, expectedVersion, imageStatus.version, isDefaultImage))
    }

    git ??= await (deps.requireGitContext ?? requireGitContext)(input.cwd)

    emitLauncherStatus(
      input,
      [
        `OpenRalph Docker image ready: ${docker.image}. Starting Dockerized ${input.phase} loop.`,
        `Run artifacts should appear under runs/openralph-${input.phase}-* shortly after the container starts.`,
        "",
      ].join("\n"),
    )

    const result = await (deps.runDockerLoop ?? runDockerLoop)({
      phase: input.phase,
      rawArgs: input.rawArgs,
      projectRoot: git.root,
      options,
      docker,
      streamOutput: input.streamOutput,
      captureOutput: input.captureOutput,
      onOutput: input.onOutput,
      signal: input.signal,
    })

    // The inner loop's status line is parsed from stdout only; stderr carries
    // heartbeat lines that share the "OpenRalph <phase> " prefix.
    const inner = extractOpenRalphSummary(input.phase, result.stdout)
    const innerSummary = translateContainerPaths(inner?.summary, git.root)

    if (inner?.status === "failed") {
      throw new Error(formatDockerInnerFailure(input.phase, innerSummary ?? inner.summary))
    }

    const userStopped = result.stopRequested === true || input.signal?.aborted === true
    if (result.exitCode !== 0 && !(userStopped || inner?.status === "stopped" || inner?.status === "blocked")) {
      throw new Error(formatDockerFailure(input.phase, parsed, result))
    }

    const displayOutput = translateContainerPaths(commandOutput(result), git.root) ?? ""
    const status = inner?.status ?? (userStopped ? "stopped" : "complete")
    return {
      phase: input.phase,
      mode,
      status,
      summary:
        status === "stopped" && !innerSummary
          ? `OpenRalph ${input.phase} Docker execution stopped by user.`
          : formatDockerSuccess(input.phase, result, git.root),
      outputTail: displayOutput ? tailLines(displayOutput, 80) : undefined,
    }
  }

  const loopSummary = await (deps.runLoop ?? runLoop)({
    phase: input.phase,
    rawArgs: input.rawArgs,
    cwd: input.cwd,
    options,
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

export async function readProjectPluginOptions(cwd: string, onWarning?: (message: string) => void): Promise<OpenRalphOptions> {
  let raw: string
  try {
    raw = await readFile(join(cwd, "opencode.json"), "utf8")
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    onWarning?.("OpenRalph could not parse opencode.json; ignoring its OpenRalph plugin options.")
    return {}
  }

  if (typeof parsed !== "object" || parsed === null) return {}
  const plugin = (parsed as { plugin?: unknown }).plugin
  if (!Array.isArray(plugin)) return {}

  for (const entry of plugin) {
    let name: unknown
    let pluginOptions: unknown
    if (typeof entry === "string") {
      name = entry
    } else if (Array.isArray(entry) && entry.length >= 1) {
      name = entry[0]
      pluginOptions = entry[1]
    } else {
      continue
    }

    if (typeof name !== "string" || !isOpenRalphPluginSpec(name)) continue
    if (pluginOptions === undefined) return {}
    try {
      return validateOptions(pluginOptions)
    } catch (error) {
      throw new Error(`opencode.json OpenRalph plugin options are invalid: ${formatError(error)}`)
    }
  }

  return {}
}

function isOpenRalphPluginSpec(name: string): boolean {
  return name.includes("open-ralph") || /(^|\/)plugin\.ts$/.test(name)
}

function mergeOptions(base: OpenRalphOptions, override: OpenRalphOptions): OpenRalphOptions {
  const merged: OpenRalphOptions = { ...base }
  if (override.defineModel !== undefined) merged.defineModel = override.defineModel
  if (override.planModel !== undefined) merged.planModel = override.planModel
  if (override.buildModel !== undefined) merged.buildModel = override.buildModel

  if (base.docker || override.docker) {
    merged.docker = {
      ...(base.docker ?? {}),
      ...(override.docker?.enabled !== undefined ? { enabled: override.docker.enabled } : {}),
      ...(override.docker?.image !== undefined ? { image: override.docker.image } : {}),
      ...(override.docker?.maskEnv !== undefined ? { maskEnv: override.docker.maskEnv } : {}),
    }
  }

  return merged
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
  const summary = translateContainerPaths(extractOpenRalphSummary(phase, result.stdout)?.summary, projectRoot)
  const lines = [`OpenRalph ${phase} Docker execution completed.`]

  if (summary) {
    lines.push("", summary)
  } else {
    const output = translateContainerPaths(commandOutput(result), projectRoot) ?? ""
    if (output) lines.push("", "Container output tail:", tailLines(output, 80))
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

export function formatDockerPullFailure(phase: LoopPhase, parsed: ParsedLoopArgs, image: string, result: CommandResult): string {
  const reason = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.exitCode}`
  const output = commandOutput(result)
  const lines = [
    `OpenRalph could not pull default Docker image ${image}: Docker exited with ${reason}`,
    "",
    "OpenRalph did not fall back to host execution because Docker mode is enabled.",
    "Verify the matching GHCR image is published and public, or fix Docker network/auth access.",
    "",
    "For local/offline use, build a local image and configure docker.image to openralph:local:",
    "  bunx @john-ezra/open-ralph docker build",
    "",
    "If you intentionally want to run this loop on the host, rerun with:",
    `  ${noDockerCommand(phase, parsed)}`,
  ]

  if (output) lines.push("", "Docker pull output tail:", tailLines(output, 80))
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

function formatMissingDockerImage(phase: LoopPhase, parsed: ParsedLoopArgs, image: string, isDefaultImage: boolean): string {
  const lines = [
    `Docker image ${image} was not found.`,
    "",
  ]

  if (isDefaultImage) {
    lines.push(
      "OpenRalph defaults to a versioned prebuilt Docker image, but the image was still missing after docker pull.",
      "Verify the matching GHCR image is published and public.",
      "For local/offline use, build a local image and configure docker.image to openralph:local:",
    )
  } else {
    lines.push(
      "Custom configured Docker images are user-managed and are not pulled automatically.",
      "Build or pull the configured image manually.",
      "For the local OpenRalph image, run:",
    )
  }

  lines.push(
    "  bunx @john-ezra/open-ralph docker build",
    "",
    "If you intentionally want to run this loop on the host, rerun with:",
    `  ${noDockerCommand(phase, parsed)}`,
  )
  return lines.join("\n")
}

function formatStaleDockerImage(
  phase: LoopPhase,
  parsed: ParsedLoopArgs,
  image: string,
  expectedVersion: string,
  imageVersion: string | undefined,
  isDefaultImage: boolean,
): string {
  const lines = [
    `Docker image ${image} is stale or was built by an older OpenRalph version.`,
    "",
    `Installed OpenRalph: ${expectedVersion}`,
    `Docker image OpenRalph: ${imageVersion ?? "unknown"}`,
    "",
  ]

  if (isDefaultImage) {
    lines.push(
      "Remove the stale local copy and rerun so OpenRalph can pull the matching prebuilt image:",
      `  docker rmi ${image}`,
      "",
      "For local/offline use, build a local image and configure docker.image to openralph:local:",
      "  bunx @john-ezra/open-ralph docker build",
    )
  } else {
    lines.push(
      "Build or pull the configured image manually.",
      "For local OpenRalph image builds:",
      "  bunx @john-ezra/open-ralph docker build",
    )
  }

  lines.push(
    "",
    "If you intentionally want to run this loop on the host, rerun with:",
    `  ${noDockerCommand(phase, parsed)}`,
  )
  return lines.join("\n")
}

function noDockerCommand(phase: LoopPhase, parsed: ParsedLoopArgs): string {
  const replayArgs = formatLoopArgsForReplay(parsed)
  return `openralph ${phase}${replayArgs ? ` ${replayArgs}` : ""} --no-docker`
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim()
}

function emitLauncherStatus(input: RunLauncherInput, chunk: string): void {
  input.onOutput?.({ stream: "stderr", chunk })
  if (input.streamOutput) process.stderr.write(chunk)
}

function translateContainerPaths(value: string | undefined, projectRoot: string | undefined): string | undefined {
  if (!value || !projectRoot) return value
  return value.split(`${CONTAINER_WORKSPACE}/runs/`).join(`${projectRoot}/runs/`)
}

interface ExtractedSummary {
  status: LoopSummary["status"]
  summary: string
}

function extractOpenRalphSummary(phase: LoopPhase, output: string): ExtractedSummary | undefined {
  // Anchor on the exact loop status line so heartbeat/diagnostic lines that
  // share the "OpenRalph <phase> " prefix can never be mistaken for a summary.
  const statusPattern = new RegExp(`^OpenRalph ${phase} (complete|max-reached|failed|stopped|blocked): `)
  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(statusPattern)
    if (match) {
      return {
        status: match[1] as LoopSummary["status"],
        summary: lines.slice(index, Math.min(lines.length, index + 8)).join("\n").trim(),
      }
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
