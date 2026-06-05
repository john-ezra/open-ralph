import { describe, expect, test } from "bun:test"
import { detectBuildSentinel, isPlanComplete } from "../src/sentinels.ts"

describe("sentinel detection", () => {
  test("detects plan completion", () => {
    expect(isPlanComplete("done\nRALPH_PLAN_COMPLETE\n")).toBe(true)
  })

  test("detects standalone build complete", () => {
    expect(detectBuildSentinel("RALPH_BLOCKED\nRALPH_COMPLETE\n")).toBe("complete")
  })

  test("uses the last standalone build sentinel line", () => {
    expect(detectBuildSentinel("RALPH_COMPLETE\nRALPH_BLOCKED\n")).toBe("blocked")
  })

  test("detects iteration completion", () => {
    expect(detectBuildSentinel("RALPH_ITERATION_COMPLETE")).toBe("iteration-complete")
  })

  test("ignores embedded build sentinel text", () => {
    expect(detectBuildSentinel("I will print RALPH_COMPLETE after committing.")).toBe("none")
  })

  test("detects blocked", () => {
    expect(detectBuildSentinel("RALPH_BLOCKED")).toBe("blocked")
  })

  test("returns none with no sentinel", () => {
    expect(detectBuildSentinel("ordinary output")).toBe("none")
  })
})
