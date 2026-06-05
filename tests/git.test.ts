import { describe, expect, test } from "bun:test"
import { buildDefensiveGitArgs } from "../src/git.ts"

describe("buildDefensiveGitArgs", () => {
  test("disables repo-controlled Git execution hooks", () => {
    const args = buildDefensiveGitArgs(["status", "--porcelain"])

    expect(args).toContain("--no-pager")
    expect(args).toContain("core.hooksPath=/dev/null")
    expect(args).toContain("core.fsmonitor=false")
    expect(args).toContain("core.pager=cat")
    expect(args.slice(-2)).toEqual(["status", "--porcelain"])
  })
})
