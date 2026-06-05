import { runCommand, type CommandResult } from "./exec.ts"

const DEFENSIVE_GIT_CONFIG = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
] as const

export interface GitContext {
  root: string
  branch: string
}

export async function requireGitContext(cwd: string): Promise<GitContext> {
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd)
  const branchResult = await runGitCommand(["branch", "--show-current"], root.stdout.trim())
  const branch = branchResult.exitCode === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : "HEAD"
  return { root: root.stdout.trim(), branch }
}

export function buildDefensiveGitArgs(args: string[]): string[] {
  return ["--no-pager", ...DEFENSIVE_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args]
}

export function runGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return runCommand("git", buildDefensiveGitArgs(args), cwd)
}

export async function getHead(cwd: string): Promise<string | undefined> {
  const result = await runGitCommand(["rev-parse", "HEAD"], cwd)
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim()
}

export async function isWorktreeClean(cwd: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], cwd)
  return result.stdout.trim() === ""
}

export async function tagExists(cwd: string, tagName: string): Promise<boolean> {
  const result = await runGitCommand(["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], cwd)
  return result.exitCode === 0
}

export async function createLightweightTag(cwd: string, tagName: string): Promise<void> {
  if (await tagExists(cwd, tagName)) throw new Error(`tag already exists: ${tagName}`)
  await runGit(["tag", tagName], cwd)
}

export async function pushCurrentBranch(cwd: string, branch: string): Promise<void> {
  if (!branch || branch === "HEAD") throw new Error("cannot push from detached HEAD")
  await runGit(["push", "origin", branch], cwd)
}

async function runGit(args: string[], cwd: string) {
  const result = await runGitCommand(args, cwd)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(detail || `git ${args.join(" ")} failed`)
  }
  return result
}
