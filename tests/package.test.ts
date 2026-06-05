import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("package metadata", () => {
  test("publishes the Bun/TypeScript package shape", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"))

    expect(pkg.name).toBe("@john-ezra/openralph")
    expect(pkg.private).toBeUndefined()
    expect(pkg.license).toBe("MIT")
    expect(pkg.main).toBe("./src/plugin.ts")
    expect(pkg.engines).toEqual({ bun: ">=1.2.0" })
    expect(pkg.publishConfig).toEqual({ access: "public" })
    expect(pkg.exports).toMatchObject({
      ".": "./src/plugin.ts",
      "./server": "./src/plugin.ts",
      "./tui": "./src/tui.ts",
      "./cli": "./src/cli.ts",
      "./package.json": "./package.json",
    })
    expect(pkg.bin).toEqual({ openralph: "bin/openralph" })
    expect(pkg.files).toContain(".dockerignore")
    expect(pkg.files).toContain("CHANGELOG.md")
    expect(pkg.files).toContain("bun.lock")
    expect(pkg.files).toContain("src/")
    expect(pkg.files).toContain("bin/openralph")
    expect(pkg.files).toContain("container/")
    expect(pkg.scripts.prepublishOnly).toBe("bun run validate")
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.devDependencies["@opencode-ai/plugin"]).toBe("1.15.13")
  })
})
