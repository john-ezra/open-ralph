export const PLAN_COMPLETE = "RALPH_PLAN_COMPLETE"
export const ITERATION_COMPLETE = "RALPH_ITERATION_COMPLETE"
export const BUILD_COMPLETE = "RALPH_COMPLETE"
export const BUILD_BLOCKED = "RALPH_BLOCKED"

export type BuildSentinel = "complete" | "iteration-complete" | "blocked" | "none"

// Sentinels are only honored near the end of the child's stdout. Prompts require a
// standalone final sentinel line; scanning the whole transcript would let echoed
// prompt files or quoted sentinel text falsely complete a run.
const SENTINEL_TAIL_LINES = 10
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function isPlanComplete(output: string): boolean {
  return sentinelCandidateLines(output).some((line) => line === PLAN_COMPLETE)
}

export function detectBuildSentinel(output: string): BuildSentinel {
  let detected: BuildSentinel = "none"

  for (const line of sentinelCandidateLines(output)) {
    if (line === BUILD_COMPLETE) detected = "complete"
    else if (line === ITERATION_COMPLETE) detected = "iteration-complete"
    else if (line === BUILD_BLOCKED) detected = "blocked"
  }

  return detected
}

function sentinelCandidateLines(output: string): string[] {
  const lines = output
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return lines.slice(-SENTINEL_TAIL_LINES)
}
