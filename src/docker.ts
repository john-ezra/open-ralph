import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, relative, sep } from "node:path"
import {
  DEFAULT_DOCKER_IMAGE,
  formatLoopArgsForReplay,
  parseLoopArgs,
  resolveDockerOptions,
  type LoopPhase,
  type OpenRalphOptions,
  type ParsedLoopArgs,
  type ResolvedDockerOptions,
} from "./args.ts"
import { startCommand, type CommandOutputEvent, type CommandResult } from "./exec.ts"
import { runGitCommand } from "./git.ts"
import { DOCKER_TOKEN_PATH } from "./trust.ts"

export const CONTAINER_WORKSPACE = "/workspace"
export const CONTAINER_HOME = "/home/opencode"
export const IMAGE_PLUGIN_PATH = "file:///opt/openralph/src/plugin.ts"
export const CHROME_DEVTOOLS_MCP_VERSION = "1.1.1"
export const CHROME_DEVTOOLS_MCP_PACKAGE = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`
export const CHROME_DEVTOOLS_MCP_WRAPPER = "/opt/openralph/bin/chrome-devtools-mcp-wrapper"
export const OPENRALPH_IMAGE_VERSION_LABEL = "org.openralph.version"
export const CHROME_DEVTOOLS_MCP_COMMAND = [
  CHROME_DEVTOOLS_MCP_WRAPPER,
  "--no-usage-statistics",
  "--no-performance-crux",
  "--experimental-vision",
] as const

const ENV_EXAMPLE_FILES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"])
const ENV_SCAN_SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"])
const CONTAINER_GIT_CONFIG = [
  ["safe.directory", CONTAINER_WORKSPACE],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
] as const

export interface RunDockerLoopInput {
  phase: LoopPhase
  rawArgs: string
  projectRoot: string
  options: OpenRalphOptions
  streamOutput?: boolean
  captureOutput?: boolean
  onOutput?: (event: CommandOutputEvent) => void
  signal?: AbortSignal
}

export interface BuildLocalDockerImageInput {
  tag?: string
  noCache?: boolean
  packageRoot?: string
  streamOutput?: boolean
  captureOutput?: boolean
  onOutput?: (event: CommandOutputEvent) => void
  signal?: AbortSignal
}

export interface BuildDockerImageArgsInput {
  tag?: string
  noCache?: boolean
  packageRoot?: string
  version?: string
}

export interface DockerImageStatus {
  exists: boolean
  version?: string
}

export interface DockerMount {
  source: string
  target: string
  readonly?: boolean
}

export interface BuildDockerArgsInput {
  phase: LoopPhase
  replayArgs: string
  projectRoot: string
  authPath: string
  options: OpenRalphOptions
  docker: ResolvedDockerOptions
  envMasks: DockerMount[]
  uid?: number
  gid?: number
  gitIdentity?: GitIdentity
  imagePluginPath?: string
  dockerToken: DockerToken
}

export interface GitIdentity {
  name: string
  email: string
}

export interface PreparedEnvMasks {
  mounts: DockerMount[]
  cleanup: () => Promise<void>
}

export interface DockerToken {
  token: string
  file: string
}

export async function runDockerLoop(input: RunDockerLoopInput): Promise<CommandResult> {
  const parsed = parseLoopArgs(input.phase, input.rawArgs)
  const docker = resolveDockerOptions(input.options)
  const authPath = defaultAuthPath()
  await requireReadableFile(authPath, "OpenCode auth file")

  const envMasks = docker.maskEnv ? await prepareEnvMasks(input.projectRoot) : emptyEnvMasks()
  const dockerToken = await prepareDockerToken()
  let activeChild: ReturnType<typeof startCommand>["child"] | undefined
  let stopRequested = false

  const onSigint = () => {
    stopRequested = true
    activeChild?.kill("SIGINT")
    process.stderr.write("\nOpenRalph Docker stop requested. Waiting for container to exit...\n")
  }

  const onAbort = () => {
    stopRequested = true
    activeChild?.kill("SIGINT")
  }

  process.on("SIGINT", onSigint)
  if (input.signal?.aborted) onAbort()
  else input.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const user = hostUser()
    const gitIdentity = input.phase === "build" ? await requireGitIdentity(input.projectRoot) : undefined
    const running = startCommand(
      "docker",
      buildDockerArgs({
        phase: input.phase,
        replayArgs: formatLoopArgsForReplay(parsed),
        projectRoot: input.projectRoot,
        authPath,
        options: input.options,
        docker,
        envMasks: envMasks.mounts,
        uid: user.uid,
        gid: user.gid,
        gitIdentity,
        dockerToken,
      }),
      {
        cwd: input.projectRoot,
        streamOutput: input.streamOutput ?? true,
        captureOutput: input.captureOutput ?? true,
        onOutput: input.onOutput,
        signal: input.signal,
      },
    )
    activeChild = running.child
    const result = await running.result
    if (stopRequested) throw new Error("Docker execution stopped by user")
    return result
  } catch (error) {
    if (stopRequested) throw new Error(`Docker execution stopped: ${formatError(error)}`)
    throw error
  } finally {
    activeChild = undefined
    process.off("SIGINT", onSigint)
    input.signal?.removeEventListener("abort", onAbort)
    await dockerToken.cleanup()
    await envMasks.cleanup()
  }
}

export function buildDockerImageArgs(input: BuildDockerImageArgsInput = {}): string[] {
  const packageRoot = input.packageRoot ?? defaultPackageRoot()
  const version = input.version ?? readPackageVersion(packageRoot)
  const args = [
    "build",
    "--file",
    join(packageRoot, "container", "Dockerfile"),
    "--tag",
    input.tag ?? DEFAULT_DOCKER_IMAGE,
    "--label",
    `${OPENRALPH_IMAGE_VERSION_LABEL}=${version}`,
  ]
  if (input.noCache) args.push("--no-cache")
  args.push(packageRoot)
  return args
}

export async function buildLocalDockerImage(input: BuildLocalDockerImageInput = {}): Promise<CommandResult> {
  const packageRoot = input.packageRoot ?? defaultPackageRoot()
  return startCommand("docker", buildDockerImageArgs({ tag: input.tag, noCache: input.noCache, packageRoot }), {
    cwd: packageRoot,
    streamOutput: input.streamOutput ?? true,
    captureOutput: input.captureOutput ?? true,
    onOutput: input.onOutput,
    signal: input.signal,
  }).result
}

export async function dockerImageExists(image: string, cwd = process.cwd()): Promise<boolean> {
  return (await inspectDockerImage(image, cwd)).exists
}

export async function inspectDockerImage(image: string, cwd = process.cwd()): Promise<DockerImageStatus> {
  const result = await startCommand("docker", ["image", "inspect", image], {
    cwd,
    streamOutput: false,
    captureOutput: true,
  }).result
  if (result.exitCode !== 0) return { exists: false }

  try {
    const parsed = JSON.parse(result.stdout) as unknown
    const imageConfig = Array.isArray(parsed) ? parsed[0] : undefined
    const labels = readDockerLabels(imageConfig)
    return { exists: true, version: labels?.[OPENRALPH_IMAGE_VERSION_LABEL] }
  } catch {
    return { exists: true }
  }
}

export function readOpenRalphPackageVersion(packageRoot = defaultPackageRoot()): string {
  return readPackageVersion(packageRoot)
}

export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const configContent = buildContainerConfig(input.options, input.docker, input.imagePluginPath)
  const args = [
    "run",
    "--pull=never",
    "--rm",
    "--shm-size=1g",
    "--workdir",
    CONTAINER_WORKSPACE,
    "--security-opt",
    "no-new-privileges:true",
  ]

  appendEnv(args, "OPENRALPH_IN_DOCKER", "1")
  appendEnv(args, "OPENRALPH_DOCKER_TOKEN", input.dockerToken.token)
  appendEnv(args, "OPENRALPH_OPTIONS_JSON", JSON.stringify(input.options))
  appendEnv(args, "OPENCODE_DISABLE_PROJECT_CONFIG", "1")
  appendEnv(args, "OPENCODE_CONFIG_CONTENT", configContent)
  appendEnv(args, "HOME", CONTAINER_HOME)
  appendGitConfigEnv(args)

  if (input.gitIdentity) appendGitIdentityEnv(args, input.gitIdentity)

  if (input.uid !== undefined && input.gid !== undefined) {
    args.push("--user", `${input.uid}:${input.gid}`)
  }

  args.push("--mount", bindMount(input.projectRoot, CONTAINER_WORKSPACE))
  args.push("--mount", bindMount(input.authPath, `${CONTAINER_HOME}/.local/share/opencode/auth.json`, true))
  args.push("--mount", bindMount(input.dockerToken.file, DOCKER_TOKEN_PATH, true))

  for (const mask of input.envMasks) {
    args.push("--mount", bindMount(mask.source, mask.target, mask.readonly ?? true))
  }

  args.push(input.docker.image, "openralph", input.phase)
  if (input.replayArgs) args.push(input.replayArgs)
  return args
}

export function buildContainerConfig(
  options: OpenRalphOptions,
  docker: ResolvedDockerOptions = resolveDockerOptions(options),
  imagePluginPath = IMAGE_PLUGIN_PATH,
): string {
  const pluginOptions: OpenRalphOptions = {
    ...(options.defineModel ? { defineModel: options.defineModel } : {}),
    ...(options.planModel ? { planModel: options.planModel } : {}),
    ...(options.buildModel ? { buildModel: options.buildModel } : {}),
    docker: {
      enabled: docker.enabled,
      image: docker.image,
      maskEnv: docker.maskEnv,
    },
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [[imagePluginPath, pluginOptions]],
    mcp: {
      "chrome-devtools": {
        type: "local",
        command: [...CHROME_DEVTOOLS_MCP_COMMAND],
        environment: {
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
        },
        enabled: true,
      },
    },
  })
}

export async function readGitIdentity(cwd: string): Promise<GitIdentity | undefined> {
  const [name, email] = await Promise.all([readGitConfigValue(cwd, "user.name"), readGitConfigValue(cwd, "user.email")])
  if (!name || !email) return undefined
  return { name, email }
}

export async function requireGitIdentity(cwd: string): Promise<GitIdentity> {
  const identity = await readGitIdentity(cwd)
  if (!identity) {
    throw new Error(
      "Dockerized OpenRalph Build requires Git user.name and user.email in host or project Git config. Configure them before rerunning Dockerized builds.",
    )
  }
  return identity
}

export async function detectMaskableEnvFiles(root: string): Promise<string[]> {
  const files: string[] = []
  await collectMaskableEnvFiles(root, files)
  return files.sort()
}

export async function prepareEnvMasks(root: string): Promise<PreparedEnvMasks> {
  const envFiles = await detectMaskableEnvFiles(root)
  if (envFiles.length === 0) return emptyEnvMasks()

  const tempDir = await mkdtemp(join(tmpdir(), "openralph-env-"))
  const mounts: DockerMount[] = []

  for (let index = 0; index < envFiles.length; index += 1) {
    const source = join(tempDir, `env-${index}`)
    await writeFile(source, "")
    mounts.push({ source, target: containerPath(root, envFiles[index]), readonly: true })
  }

  return {
    mounts,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  }
}

export function shouldMaskEnvFile(path: string): boolean {
  const name = basename(path)
  return name.startsWith(".env") && !ENV_EXAMPLE_FILES.has(name)
}

export function containerPath(root: string, path: string): string {
  const rel = relative(root, path)
  return `${CONTAINER_WORKSPACE}/${rel.split(sep).join("/")}`
}

function bindMount(source: string, target: string, readonly = false): string {
  validateMountPath(source, "source")
  validateMountPath(target, "target")
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`
}

function validateMountPath(value: string, label: "source" | "target"): void {
  if (value === "" || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Docker mount ${label} must not be empty or contain commas/newlines: ${value}`)
  }
  if (!value.startsWith("/")) {
    throw new Error(`Docker mount ${label} must be an absolute path: ${value}`)
  }
}

function appendEnv(args: string[], name: string, value: string): void {
  args.push("--env", `${name}=${value}`)
}

function appendGitConfigEnv(args: string[]): void {
  appendEnv(args, "GIT_CONFIG_COUNT", String(CONTAINER_GIT_CONFIG.length))
  CONTAINER_GIT_CONFIG.forEach(([key, value], index) => {
    appendEnv(args, `GIT_CONFIG_KEY_${index}`, key)
    appendEnv(args, `GIT_CONFIG_VALUE_${index}`, value)
  })
}

function appendGitIdentityEnv(args: string[], identity: GitIdentity): void {
  appendEnv(args, "GIT_AUTHOR_NAME", identity.name)
  appendEnv(args, "GIT_AUTHOR_EMAIL", identity.email)
  appendEnv(args, "GIT_COMMITTER_NAME", identity.name)
  appendEnv(args, "GIT_COMMITTER_EMAIL", identity.email)
}

async function readGitConfigValue(cwd: string, key: string): Promise<string | undefined> {
  const result = await runGitCommand(["config", "--get", key], cwd)
  if (result.exitCode !== 0) return undefined
  const value = result.stdout.trim()
  return value || undefined
}

function defaultAuthPath(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json")
}

function defaultPackageRoot(): string {
  return join(import.meta.dir, "..")
}

function readPackageVersion(packageRoot: string): string {
  const raw = readFileSync(join(packageRoot, "package.json"), "utf8")
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { version?: unknown }).version !== "string") {
    throw new Error(`OpenRalph package.json at ${packageRoot} does not contain a string version`)
  }
  return (parsed as { version: string }).version
}

function readDockerLabels(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const config = (value as { Config?: unknown }).Config
  if (typeof config !== "object" || config === null) return undefined
  const labels = (config as { Labels?: unknown }).Labels
  if (typeof labels !== "object" || labels === null) return undefined

  const result: Record<string, string> = {}
  for (const [key, labelValue] of Object.entries(labels)) {
    if (typeof labelValue === "string") result[key] = labelValue
  }
  return result
}

async function requireReadableFile(path: string, label: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} not found at ${path}`)
  }
}

async function collectMaskableEnvFiles(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!ENV_SCAN_SKIP_DIRS.has(entry.name)) await collectMaskableEnvFiles(path, files)
      continue
    }

    if (entry.isFile() && shouldMaskEnvFile(path)) files.push(path)
  }
}

function emptyEnvMasks(): PreparedEnvMasks {
  return { mounts: [], cleanup: async () => {} }
}

async function prepareDockerToken(): Promise<DockerToken & { cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "openralph-docker-"))
  const token = randomBytes(32).toString("hex")
  const file = join(tempDir, "docker-token")
  await writeFile(file, token)
  return { token, file, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function hostUser(): { uid?: number; gid?: number } {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return {}
  return { uid: process.getuid(), gid: process.getgid() }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
