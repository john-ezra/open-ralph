export const PLAN_COMPLETE = "RALPH_PLAN_COMPLETE"
export const ITERATION_COMPLETE = "RALPH_ITERATION_COMPLETE"
export const BUILD_COMPLETE = "RALPH_COMPLETE"
export const BUILD_BLOCKED = "RALPH_BLOCKED"

export type BuildSentinel = "complete" | "iteration-complete" | "blocked" | "none"

export function isPlanComplete(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === PLAN_COMPLETE)
}

export function detectBuildSentinel(output: string): BuildSentinel {
  let detected: BuildSentinel = "none"

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === BUILD_COMPLETE) detected = "complete"
    else if (trimmed === ITERATION_COMPLETE) detected = "iteration-complete"
    else if (trimmed === BUILD_BLOCKED) detected = "blocked"
  }

  return detected
}
