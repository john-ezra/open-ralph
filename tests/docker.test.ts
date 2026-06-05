import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  buildContainerConfig,
  buildDockerArgs,
  buildDockerImageArgs,
  CHROME_DEVTOOLS_MCP_COMMAND,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  CHROME_DEVTOOLS_MCP_WRAPPER,
  containerPath,
  detectMaskableEnvFiles,
  IMAGE_PLUGIN_PATH,
  shouldMaskEnvFile,
} from "../src/docker.ts"

describe("buildContainerConfig", () => {
  test("loads only image-bundled OpenRalph", () => {
    const config = JSON.parse(
      buildContainerConfig(
        { planModel: "provider/plan", docker: { enabled: true } },
        { enabled: true, image: "openralph:local", maskEnv: true },
      ),
    )

    expect(config.plugin).toEqual([
      [
        IMAGE_PLUGIN_PATH,
        {
          planModel: "provider/plan",
          docker: { enabled: true, image: "openralph:local", maskEnv: true },
        },
      ],
    ])
  })

  test("adds Chrome DevTools MCP for browser validation", () => {
    const config = JSON.parse(buildContainerConfig({}, { enabled: true, image: "openralph:local", maskEnv: true }))

    expect(config.mcp["chrome-devtools"]).toEqual({
      type: "local",
      command: [...CHROME_DEVTOOLS_MCP_COMMAND],
      environment: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
      enabled: true,
    })
    expect(config.mcp["chrome-devtools"].command).toContain("--no-usage-statistics")
    expect(config.mcp["chrome-devtools"].command).toContain("--no-performance-crux")
    expect(config.mcp["chrome-devtools"].command).toContain("--experimental-vision")
    expect(config.mcp["chrome-devtools"].command[0]).toBe(CHROME_DEVTOOLS_MCP_WRAPPER)
    expect(config.mcp["chrome-devtools"].command.join(" ")).not.toContain("latest")
  })
})

describe("buildDockerArgs", () => {
  test("builds isolated Docker invocation", () => {
    const args = buildDockerArgs({
      phase: "build",
      replayArgs: "5 --model provider/model",
      projectRoot: "/repo",
      authPath: "/auth/auth.json",
      options: { docker: { enabled: true } },
      docker: { enabled: true, image: "openralph:local", maskEnv: true },
      envMasks: [{ source: "/tmp/empty-env", target: "/workspace/.env", readonly: true }],
      uid: 1000,
      gid: 1000,
      gitIdentity: { name: "Ezra Example", email: "ezra@example.com" },
      dockerToken: { token: "docker-token", file: "/tmp/docker-token" },
    })

    expect(args[0]).toBe("run")
    expect(args).toContain("--pull=never")
    expect(args).toContain("--shm-size=1g")
    expect(args).toContain("OPENRALPH_IN_DOCKER=1")
    expect(args).toContain("OPENRALPH_DOCKER_TOKEN=docker-token")
    expect(args).toContain('OPENRALPH_OPTIONS_JSON={"docker":{"enabled":true}}')
    expect(args).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1")
    expect(args).toContain("HOME=/home/opencode")
    expect(args).toContain("GIT_CONFIG_COUNT=3")
    expect(args).toContain("GIT_CONFIG_KEY_0=safe.directory")
    expect(args).toContain("GIT_CONFIG_VALUE_0=/workspace")
    expect(args).toContain("GIT_CONFIG_KEY_1=commit.gpgsign")
    expect(args).toContain("GIT_CONFIG_VALUE_1=false")
    expect(args).toContain("GIT_CONFIG_KEY_2=tag.gpgsign")
    expect(args).toContain("GIT_CONFIG_VALUE_2=false")
    expect(args).toContain("GIT_AUTHOR_NAME=Ezra Example")
    expect(args).toContain("GIT_AUTHOR_EMAIL=ezra@example.com")
    expect(args).toContain("GIT_COMMITTER_NAME=Ezra Example")
    expect(args).toContain("GIT_COMMITTER_EMAIL=ezra@example.com")
    expect(args).toContain("--user")
    expect(args).toContain("1000:1000")
    expect(args).toContain("type=bind,source=/repo,target=/workspace")
    expect(args).toContain("type=bind,source=/auth/auth.json,target=/home/opencode/.local/share/opencode/auth.json,readonly")
    expect(args).toContain("type=bind,source=/tmp/docker-token,target=/run/openralph/docker-token,readonly")
    expect(args).toContain("type=bind,source=/tmp/empty-env,target=/workspace/.env,readonly")
    expect(args).toContain("openralph:local")
    expect(args.slice(-4)).toEqual([
      "openralph:local",
      "openralph",
      "build",
      "5 --model provider/model",
    ])
    const argText = args.join("\n")
    expect(argText).not.toContain("--command\nralph-build")
    expect(argText).not.toContain("/var/run/docker.sock")
    expect(argText).not.toContain(".ssh")
    expect(argText).not.toContain(".gitconfig")
    expect(argText).not.toContain(".gnupg")
    expect(argText).not.toContain("SSH_AUTH_SOCK")
    expect(argText).not.toContain("chrome-profile")
    expect(argText).not.toContain("/run/user")
  })

  test("rejects mount paths that can inject Docker mount options", () => {
    const input = {
      phase: "plan" as const,
      replayArgs: "",
      projectRoot: "/repo,readonly",
      authPath: "/auth/auth.json",
      options: { docker: { enabled: true } },
      docker: { enabled: true, image: "openralph:local", maskEnv: true },
      envMasks: [],
      dockerToken: { token: "docker-token", file: "/tmp/docker-token" },
    }

    expect(() => buildDockerArgs(input)).toThrow("Docker mount source")
    expect(() => buildDockerArgs({ ...input, projectRoot: "/repo", envMasks: [{ source: "/tmp/env", target: "/workspace/.env,target=/x" }] })).toThrow(
      "Docker mount target",
    )
  })
})

describe("buildDockerImageArgs", () => {
  test("builds the local image from the package root", () => {
    expect(buildDockerImageArgs({ packageRoot: "/opt/openralph" })).toEqual([
      "build",
      "--file",
      "/opt/openralph/container/Dockerfile",
      "--tag",
      "openralph:local",
      "/opt/openralph",
    ])
  })

  test("accepts custom tag and no-cache", () => {
    expect(buildDockerImageArgs({ packageRoot: "/opt/openralph", tag: "openralph:test", noCache: true })).toEqual([
      "build",
      "--file",
      "/opt/openralph/container/Dockerfile",
      "--tag",
      "openralph:test",
      "--no-cache",
      "/opt/openralph",
    ])
  })
})

describe("Dockerfile browser tooling", () => {
  test("pins Chrome DevTools MCP in the image", async () => {
    const dockerfile = await readFile(join(import.meta.dir, "..", "container", "Dockerfile"), "utf8")

    expect(CHROME_DEVTOOLS_MCP_PACKAGE).toBe("chrome-devtools-mcp@1.1.1")
    expect(dockerfile).toContain("ARG CHROME_DEVTOOLS_MCP_VERSION=1.1.1")
    expect(dockerfile).toContain("npm install --global chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}")
    expect(dockerfile).toContain("COPY container/bin ./bin")
    expect(dockerfile).toContain("COPY bin/openralph ./bin/openralph")
    expect(dockerfile).toContain("bun install --production --frozen-lockfile")
    expect(dockerfile).toContain("PATH=/opt/openralph/bin:/usr/local/bin")
    expect(dockerfile).toContain("chmod +x /opt/openralph/bin/chrome-devtools-mcp-wrapper /opt/openralph/bin/openralph")
    expect(dockerfile).toContain("google-chrome-stable")
    expect(dockerfile).toContain("nodejs")
    expect(dockerfile).toContain("python3-venv")
    expect(dockerfile).toContain("build-essential")
    expect(dockerfile).toContain("ripgrep")
    expect(dockerfile).toContain("USER opencode")
  })

  test("wrapper launches Chrome for browser-url MCP mode", async () => {
    const wrapper = await readFile(join(import.meta.dir, "..", "container", "bin", "chrome-devtools-mcp-wrapper"), "utf8")

    expect(wrapper).toContain("--remote-debugging-address=127.0.0.1")
    expect(wrapper).toContain("--remote-debugging-port=0")
    expect(wrapper).toContain("--no-sandbox")
    expect(wrapper).toContain("--window-size=1440,1000")
    expect(wrapper).toContain('ready="true"')
    expect(wrapper).toContain('[ "${ready}" != "true" ]')
    expect(wrapper).toContain("chrome-devtools-mcp --browser-url=")
  })
})

describe("env masking", () => {
  test("classifies env files", () => {
    expect(shouldMaskEnvFile("/repo/.env")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.env.local")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.env.example")).toBe(false)
    expect(shouldMaskEnvFile("/repo/.env.sample")).toBe(false)
    expect(shouldMaskEnvFile("/repo/not-env")).toBe(false)
  })

  test("detects maskable env files recursively", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-test-"))
    try {
      await mkdir(join(root, "nested"))
      await writeFile(join(root, ".env"), "SECRET=1")
      await writeFile(join(root, ".env.example"), "SECRET=")
      await writeFile(join(root, "nested", ".env.production"), "SECRET=2")

      expect((await detectMaskableEnvFiles(root)).map((path) => containerPath(root, path))).toEqual([
        "/workspace/.env",
        "/workspace/nested/.env.production",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
