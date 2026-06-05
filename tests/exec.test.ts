import { describe, expect, test } from "bun:test"
import { commandExists, startCommand, type CommandOutputEvent } from "../src/exec.ts"

describe("startCommand", () => {
  test("reports output chunks without streaming them", async () => {
    const events: CommandOutputEvent[] = []
    const running = startCommand(process.execPath, ["-e", "process.stdout.write('visible')"], {
      cwd: process.cwd(),
      streamOutput: false,
      onOutput: (event) => events.push(event),
    })

    const result = await running.result

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("visible")
    expect(events).toEqual([{ stream: "stdout", chunk: "visible" }])
  })

  test("checks whether a command can be spawned", async () => {
    await expect(commandExists(process.execPath)).resolves.toBe(true)
    await expect(commandExists("openralph-definitely-missing-command")).resolves.toBe(false)
  })
})
