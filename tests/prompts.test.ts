import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("bundled prompts", () => {
  test("build completion requires final plan and validation reconciliation", async () => {
    const prompt = await readPrompt("PROMPT_build.md")

    expect(prompt).toMatch(/Before committing,[\s\S]*obsolete pass\/fail counts/)
    expect(prompt).toMatch(/before printing `RALPH_COMPLETE`[\s\S]*stale or contradictory progress and validation text/)
    expect(prompt).toMatch(/commit the plan-only cleanup[\s\S]*`RALPH_ITERATION_COMPLETE`/)
    expect(prompt).toMatch(/Only when validation passes[\s\S]*`IMPLEMENTATION_PLAN\.md` accurately reflects no actionable work remaining/)
  })

  test("plan and build prompts avoid active run artifacts", async () => {
    const planPrompt = await readPrompt("PROMPT_plan.md")
    const buildPrompt = await readPrompt("PROMPT_build.md")

    for (const prompt of [planPrompt, buildPrompt]) {
      expect(prompt).toContain("`ralph.log` contains the final `OpenRalph <phase> run finished` section")
      expect(prompt).toContain("OpenRalph build run finished")
      expect(prompt).toContain("current run is being written concurrently")
      expect(prompt).toContain("Do not persist notes about ignored current-run artifacts in `IMPLEMENTATION_PLAN.md`")
    }
  })

  test("build prompt avoids masking clean-status blockers", async () => {
    const prompt = await readPrompt("PROMPT_build.md")

    expect(prompt).toContain("Do not edit `.git/info/exclude` or ignore rules just to hide unrelated files")
    expect(prompt).toContain("document the blocker or ask for fixture cleanup")
  })

  test("build final completion uses verification-only todos", async () => {
    const prompt = await readPrompt("PROMPT_build.md")

    expect(prompt).toContain("switch to final-verification-only todos")
    expect(prompt).toContain("Do not leave implementation or commit todos unchecked when no implementation or commit is needed")
  })
})

function readPrompt(fileName: string): Promise<string> {
  return readFile(join(import.meta.dir, "..", fileName), "utf8")
}
