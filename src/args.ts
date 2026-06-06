export type LoopPhase = "plan" | "build"

export const DEFAULT_LOCAL_DOCKER_IMAGE = "openralph:local"
export const DEFAULT_DOCKER_IMAGE_REPOSITORY = "ghcr.io/john-ezra/open-ralph"

const DOCKER_DOMAIN_COMPONENT = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
const DOCKER_NAME_COMPONENT = "[a-z0-9]+(?:(?:[._-]+|__)[a-z0-9]+)*"
const DOCKER_IMAGE_PATTERN = new RegExp(
  `^(?=.{1,255}$)(?:${DOCKER_DOMAIN_COMPONENT}(?:\\.${DOCKER_DOMAIN_COMPONENT})*(?::[0-9]+)?/)?${DOCKER_NAME_COMPONENT}(?:/${DOCKER_NAME_COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[A-Fa-f0-9]{64})?$`,
)

export interface OpenRalphOptions {
  defineModel?: string
  planModel?: string
  buildModel?: string
  docker?: DockerOptions
}

export interface DockerOptions {
  enabled?: boolean
  image?: string
  maskEnv?: boolean
}

export interface ResolvedDockerOptions {
  enabled: boolean
  image: string
  maskEnv: boolean
}

export interface ParsedLoopArgs {
  maxIterations?: number
  model?: string
  push: boolean
  noDocker: boolean
}

export function validateOptions(input: unknown): OpenRalphOptions {
  if (input == null) return {}
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("OpenRalph plugin options must be an object")
  }

  const options = input as Record<string, unknown>
  return {
    defineModel: readOptionalModel(options, "defineModel"),
    planModel: readOptionalModel(options, "planModel"),
    buildModel: readOptionalModel(options, "buildModel"),
    docker: readDockerOptions(options),
  }
}

export function parseLoopArgs(phase: LoopPhase, raw: string): ParsedLoopArgs {
  const tokens = splitArgs(raw)
  const parsed: ParsedLoopArgs = { push: false, noDocker: false }
  let hasMax = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token === "--model") {
      if (parsed.model) throw new Error("--model can only be provided once")
      const value = tokens[index + 1]
      if (!value || !isValidModelValue(value)) {
        throw new Error("--model requires a provider/model value")
      }
      parsed.model = value
      index += 1
      continue
    }

    if (token === "--push") {
      if (phase !== "build") throw new Error("--push is only supported for OpenRalph Build")
      if (parsed.push) throw new Error("--push can only be provided once")
      parsed.push = true
      continue
    }

    if (token === "--no-docker") {
      if (parsed.noDocker) throw new Error("--no-docker can only be provided once")
      parsed.noDocker = true
      continue
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown flag: ${token}`)
    }

    if (!isPositiveIntegerToken(token)) {
      throw new Error(`Unexpected argument: ${token}`)
    }
    if (hasMax) throw new Error("max iterations can only be provided once")

    const maxIterations = Number(token)
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      throw new Error("max iterations must be a positive integer")
    }

    parsed.maxIterations = maxIterations
    hasMax = true
  }

  return parsed
}

export function formatLoopArgsForReplay(args: ParsedLoopArgs): string {
  const tokens: string[] = []
  if (args.maxIterations !== undefined) tokens.push(String(args.maxIterations))
  if (args.model) tokens.push("--model", args.model)
  if (args.push) tokens.push("--push")
  return tokens.map(quoteArg).join(" ")
}

export function defaultPublishedDockerImage(version: string): string {
  return validateDockerImageReference(`${DEFAULT_DOCKER_IMAGE_REPOSITORY}:${version}`, "default Docker image")
}

export function resolveDockerOptions(options: OpenRalphOptions, defaultImage = DEFAULT_LOCAL_DOCKER_IMAGE): ResolvedDockerOptions {
  return {
    enabled: options.docker?.enabled ?? true,
    image: options.docker?.image ?? defaultImage,
    maskEnv: options.docker?.maskEnv ?? true,
  }
}

export function validateDockerImageReference(value: string, label = "docker.image"): string {
  if (!DOCKER_IMAGE_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid Docker image reference`)
  }
  return value
}

export function resolveModel(
  phase: LoopPhase,
  args: ParsedLoopArgs,
  options: OpenRalphOptions,
): string | undefined {
  if (args.model) return args.model
  return phase === "plan" ? options.planModel : options.buildModel
}

function readOptionalString(options: Record<string, unknown>, key: "defineModel" | "planModel" | "buildModel" | "image"): string | undefined {
  const value = options[key]
  if (value == null) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string when provided`)
  if (value.trim() === "") throw new Error(`${key} must not be empty when provided`)
  return value
}

function readOptionalModel(options: Record<string, unknown>, key: "defineModel" | "planModel" | "buildModel"): string | undefined {
  const value = readOptionalString(options, key)
  if (value === undefined) return undefined
  if (!isValidModelValue(value)) throw new Error(`${key} must be a provider/model value`)
  return value
}

function readDockerOptions(options: Record<string, unknown>): DockerOptions | undefined {
  const value = options.docker
  if (value == null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("docker must be an object when provided")
  }

  const docker = value as Record<string, unknown>
  const image = readOptionalString(docker, "image")
  return {
    enabled: readOptionalBoolean(docker, "enabled"),
    image: image === undefined ? undefined : validateDockerImageReference(image),
    maskEnv: readOptionalBoolean(docker, "maskEnv"),
  }
}

function readOptionalBoolean(options: Record<string, unknown>, key: "enabled" | "maskEnv"): boolean | undefined {
  const value = options[key]
  if (value == null) return undefined
  if (typeof value !== "boolean") throw new Error(`docker.${key} must be a boolean when provided`)
  return value
}

function isPositiveIntegerToken(token: string): boolean {
  return /^[0-9]+$/.test(token) && Number(token) > 0
}

function isValidModelValue(value: string): boolean {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return false
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) && !model.startsWith("-") && !/[,\s]/.test(model)
}

function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === "\\" && quote !== "'") {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (escaping) current += "\\"
  if (quote) throw new Error("Unterminated quoted argument")
  if (current) tokens.push(current)
  return tokens
}

function quoteArg(token: string): string {
  if (/^[^\s"'\\]+$/.test(token)) return token
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
