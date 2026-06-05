import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, normalize } from "node:path"
import { pathToFileURL } from "node:url"
import { runCommand } from "./exec.ts"

export interface ReleaseCheckFinding {
  file: string
  line: number
  reason: string
  marker: string
}

export interface ForbiddenPathMarker {
  reason: string
  value: string
}

export interface ReleaseCheckResult {
  files: string[]
  findings: ReleaseCheckFinding[]
}

interface NpmPackFile {
  path?: string
}

interface NpmPackEntry {
  files?: NpmPackFile[]
}

export async function runReleaseCheck(cwd = process.cwd()): Promise<ReleaseCheckResult> {
  const [trackedFiles, packedFiles] = await Promise.all([listGitTrackedFiles(cwd), listNpmPackFiles(cwd)])
  const files = uniqueSorted([...trackedFiles, ...packedFiles])
  const findings = await scanFilesForForbiddenPaths(cwd, files, buildForbiddenPathMarkers(cwd))
  return { files, findings }
}

export function buildForbiddenPathMarkers(projectRoot: string, home = homedir()): ForbiddenPathMarker[] {
  const markers: ForbiddenPathMarker[] = []
  const seen = new Set<string>()

  addMarker(markers, seen, pathToFileURL(normalizePath(home)).href, "file URL pointing into the current user's home directory")
  addMarker(markers, seen, normalizePath(home), "absolute path under the current user's home directory")
  addMarker(markers, seen, normalizePath(projectRoot), "absolute path into this local OpenRalph checkout")

  return markers
}

export async function scanFilesForForbiddenPaths(
  cwd: string,
  files: string[],
  markers = buildForbiddenPathMarkers(cwd),
): Promise<ReleaseCheckFinding[]> {
  const findings: ReleaseCheckFinding[] = []

  for (const file of files) {
    let content: Buffer
    try {
      content = await readFile(join(cwd, file))
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }

    if (content.includes(0)) continue

    const lines = content.toString("utf8").split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      for (const marker of markers) {
        if (lines[index].includes(marker.value)) {
          findings.push({ file, line: index + 1, reason: marker.reason, marker: marker.value })
          break
        }
      }
    }
  }

  return findings
}

function addMarker(markers: ForbiddenPathMarker[], seen: Set<string>, value: string, reason: string): void {
  if (!value || value === "/" || seen.has(value)) return
  seen.add(value)
  markers.push({ value, reason })
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\/$/, "")
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function listGitTrackedFiles(cwd: string): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "-z"], cwd)
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim() || "unknown error"}`)
  return result.stdout.split("\0").filter(Boolean)
}

async function listNpmPackFiles(cwd: string): Promise<string[]> {
  const result = await runCommand("npm", ["pack", "--dry-run", "--json"], cwd)
  if (result.exitCode !== 0) throw new Error(`npm pack --dry-run failed: ${result.stderr.trim() || "unknown error"}`)

  let entries: NpmPackEntry[]
  try {
    entries = JSON.parse(result.stdout.trim()) as NpmPackEntry[]
  } catch (error) {
    throw new Error(`npm pack --dry-run returned invalid JSON: ${formatError(error)}`)
  }
  return entries.flatMap((entry) => entry.files?.map((file) => file.path).filter((path): path is string => Boolean(path)) ?? [])
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function formatFindings(findings: ReleaseCheckFinding[]): string {
  return [
    "Release path check failed: found local machine paths in public files.",
    ...findings.map((finding) => `${finding.file}:${finding.line}: ${finding.reason}: ${finding.marker}`),
  ].join("\n")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) {
  try {
    const result = await runReleaseCheck()
    if (result.findings.length > 0) {
      process.stderr.write(`${formatFindings(result.findings)}\n`)
      process.exit(1)
    }

    process.stdout.write(`Release path check passed: scanned ${result.files.length} public files.\n`)
  } catch (error) {
    process.stderr.write(`Release path check failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
