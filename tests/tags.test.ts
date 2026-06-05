import { describe, expect, test } from "bun:test"
import { createBuildRunId, createBuildTagName, createTimestampId } from "../src/tags.ts"

describe("tag helpers", () => {
  test("formats run id", () => {
    expect(createBuildRunId(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405")
  })

  test("formats shared timestamp ids", () => {
    expect(createTimestampId(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405")
  })

  test("formats build tag names", () => {
    expect(createBuildTagName("20260102-030405", 7)).toBe("openralph/build-20260102-030405/007")
  })

  test("rejects invalid tag index", () => {
    expect(() => createBuildTagName("run", 0)).toThrow("tag index")
  })
})
