import { readOptionsFromEnv, runOpenRalphLauncher, type RunLauncherInput } from "./launcher.ts"
import { DEFAULT_LOCAL_DOCKER_IMAGE, validateDockerImageReference, type LoopPhase } from "./args.ts"
import { buildLocalDockerImage } from "./docker.ts"
import type { CommandResult } from "./exec.ts"

export interface CliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: Pick<NodeJS.WritableStream, "write">
  stdout?: Pick<NodeJS.WritableStream, "write">
  runLauncher?: typeof runOpenRalphLauncher
  buildDockerImage?: typeof buildLocalDockerImage
}

export async function runCli(argv = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const command = argv[0]

  if (command === "docker") return runDockerCli(argv.slice(1), deps)

  if (command !== "plan" && command !== "build") {
    stderr.write(`${usage()}\n`)
    return 2
  }

  try {
    const phase = command as LoopPhase
    const options = readOptionsFromEnv(deps.env)
    const input: RunLauncherInput = {
      phase,
      rawArgs: argv.slice(1).join(" "),
      cwd: deps.cwd ?? process.cwd(),
      options,
      streamOutput: true,
      captureOutput: true,
    }
    const result = await (deps.runLauncher ?? runOpenRalphLauncher)(input, { env: deps.env })
    stdout.write(`${result.summary}\n`)
    // 130 follows the 128+SIGINT convention so wrapping scripts do not treat an
    // interrupted run as a completed one. max-reached stays 0: bounded runs
    // (e.g. the documented `build 1` smoke test) reach it intentionally.
    if (result.status === "failed" || result.status === "blocked") return 1
    if (result.status === "stopped") return 130
    return 0
  } catch (error) {
    stderr.write(`OpenRalph failed: ${formatError(error)}\n`)
    return 1
  }
}

async function runDockerCli(argv: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const subcommand = argv[0]

  if (subcommand !== "build") {
    stderr.write(`${usage()}\n`)
    return 2
  }

  try {
    const input = parseDockerBuildArgs(argv.slice(1))
    const result = await (deps.buildDockerImage ?? buildLocalDockerImage)({
      tag: input.tag,
      noCache: input.noCache,
      streamOutput: true,
      captureOutput: true,
    })

    if (result.exitCode !== 0) {
      stderr.write(`${formatDockerBuildFailure(result)}\n`)
      return 1
    }

    stdout.write(`OpenRalph Docker image built: ${input.tag}\n`)
    return 0
  } catch (error) {
    stderr.write(`OpenRalph failed: ${formatError(error)}\n`)
    return 1
  }
}

function parseDockerBuildArgs(argv: string[]): { tag: string; noCache: boolean } {
  const parsed = { tag: DEFAULT_LOCAL_DOCKER_IMAGE, noCache: false }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === "--tag") {
      const value = argv[index + 1]
      if (!value || value.startsWith("-")) throw new Error("--tag requires an image tag")
      parsed.tag = validateDockerImageReference(value, "--tag")
      index += 1
      continue
    }

    if (token === "--no-cache") {
      parsed.noCache = true
      continue
    }

    if (token.startsWith("-")) throw new Error(`Unknown flag: ${token}`)
    throw new Error(`Unexpected argument: ${token}`)
  }

  return parsed
}

function formatDockerBuildFailure(result: CommandResult): string {
  const reason = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.exitCode}`
  return `OpenRalph Docker image build failed: Docker exited with ${reason}`
}

function usage(): string {
  return [
    "Usage:",
    "  openralph plan [max] [--model <model>] [--no-docker]",
    "  openralph build [max] [--model <model>] [--push] [--no-docker]",
    "  openralph docker build [--tag <image>] [--no-cache]",
  ].join("\n")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) {
  process.exit(await runCli())
}
