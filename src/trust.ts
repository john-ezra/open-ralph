import { randomBytes } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

export const DOCKER_TOKEN_PATH = "/run/openralph/docker-token"

export interface TrustDeps {
  containerEvidence?: () => Promise<boolean>
  dockerTokenPath?: string
  pathExists?: (path: string) => Promise<boolean>
  readTextFile?: (path: string) => Promise<string>
}

export interface HostLoopToken {
  env: Record<string, string>
  cleanup: () => Promise<void>
}

export async function hasDockerMarker(env: NodeJS.ProcessEnv = process.env, deps: TrustDeps = {}): Promise<boolean> {
  if (env.OPENRALPH_IN_DOCKER === "1") return true
  if (env.OPENRALPH_DOCKER_TOKEN) return true
  return hasContainerEvidence(deps)
}

export async function attestDockerEnvironment(env: NodeJS.ProcessEnv = process.env, deps: TrustDeps = {}): Promise<boolean> {
  const token = env.OPENRALPH_DOCKER_TOKEN
  if (!token || token.trim() === "") return false
  if (!(await hasContainerEvidence(deps))) return false

  try {
    const fileToken = await readText(deps.dockerTokenPath ?? DOCKER_TOKEN_PATH, deps)
    return fileToken.length > 0 && fileToken === token
  } catch {
    return false
  }
}

export async function authorizeLoopChild(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
  deps: TrustDeps = {},
): Promise<boolean> {
  if (env.OPENRALPH_LOOP_CHILD !== "1") return false
  if (await attestDockerEnvironment(env, deps)) return true
  return authorizeHostLoopChild(env, projectRoot, deps)
}

export async function authorizeHostLoopChild(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
  deps: TrustDeps = {},
): Promise<boolean> {
  const token = env.OPENRALPH_HOST_LOOP_TOKEN
  const tokenFile = env.OPENRALPH_HOST_LOOP_TOKEN_FILE
  if (!token || token.trim() === "" || !tokenFile || !isAbsolute(tokenFile)) return false
  if (projectRoot && isPathInside(projectRoot, tokenFile)) return false

  try {
    const fileToken = await readText(tokenFile, deps)
    return fileToken.length > 0 && fileToken === token
  } catch {
    return false
  }
}

export async function createHostLoopToken(): Promise<HostLoopToken> {
  const tempDir = await mkdtemp(join(tmpdir(), "openralph-host-child-"))
  const token = randomBytes(32).toString("hex")
  const tokenFile = join(tempDir, "token")
  await writeFile(tokenFile, token)

  return {
    env: {
      OPENRALPH_HOST_LOOP_TOKEN: token,
      OPENRALPH_HOST_LOOP_TOKEN_FILE: tokenFile,
    },
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  }
}

async function hasContainerEvidence(deps: TrustDeps): Promise<boolean> {
  if (deps.containerEvidence) return deps.containerEvidence()

  const hasExpectedPaths = (await pathExists("/workspace", deps)) && (await pathExists("/opt/openralph", deps))
  if (!hasExpectedPaths) return false

  if (await pathExists("/.dockerenv", deps)) return true

  try {
    const cgroup = await readText("/proc/1/cgroup", deps)
    return /docker|containerd|kubepods|podman/i.test(cgroup)
  } catch {
    return false
  }
}

async function pathExists(path: string, deps: TrustDeps): Promise<boolean> {
  if (deps.pathExists) return deps.pathExists(path)
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readText(path: string, deps: TrustDeps): Promise<string> {
  if (deps.readTextFile) return deps.readTextFile(path)
  return readFile(path, "utf8")
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}
