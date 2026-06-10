import { existsSync } from "node:fs"
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { runCommand } from "../src/exec.ts"
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
  OPENRALPH_IMAGE_VERSION_LABEL,
  pullDockerImage,
  resolveRuntimeDockerOptions,
  runDockerLoop,
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
      containerName: "openralph-build-abc123def456",
    })

    expect(args[0]).toBe("run")
    expect(args).toContain("--name")
    expect(args).toContain("openralph-build-abc123def456")
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
    expect(buildDockerImageArgs({ packageRoot: "/opt/openralph", version: "1.2.3" })).toEqual([
      "build",
      "--file",
      "/opt/openralph/container/Dockerfile",
      "--tag",
      "openralph:local",
      "--label",
      `${OPENRALPH_IMAGE_VERSION_LABEL}=1.2.3`,
      "/opt/openralph",
    ])
  })

  test("accepts custom tag and no-cache", () => {
    expect(buildDockerImageArgs({ packageRoot: "/opt/openralph", tag: "openralph:test", noCache: true, version: "1.2.3" })).toEqual([
      "build",
      "--file",
      "/opt/openralph/container/Dockerfile",
      "--tag",
      "openralph:test",
      "--label",
      `${OPENRALPH_IMAGE_VERSION_LABEL}=1.2.3`,
      "--no-cache",
      "/opt/openralph",
    ])
  })
})

describe("resolveRuntimeDockerOptions", () => {
  test("defaults runtime Docker to the matching published image", () => {
    expect(resolveRuntimeDockerOptions({}, "1.2.3")).toEqual({
      enabled: true,
      image: "ghcr.io/john-ezra/open-ralph:1.2.3",
      maskEnv: true,
    })
  })

  test("preserves explicit Docker image overrides", () => {
    expect(resolveRuntimeDockerOptions({ docker: { image: "openralph:local" } }, "1.2.3")).toEqual({
      enabled: true,
      image: "openralph:local",
      maskEnv: true,
    })
  })
})

describe("Dockerfile browser tooling", () => {
  test("pins Chrome DevTools MCP in the image", async () => {
    const dockerfile = await readFile(join(import.meta.dir, "..", "container", "Dockerfile"), "utf8")

    expect(CHROME_DEVTOOLS_MCP_PACKAGE).toBe("chrome-devtools-mcp@1.1.1")
    expect(dockerfile).toContain("ARG TARGETARCH")
    expect(dockerfile).toContain("ARG CHROME_DEVTOOLS_MCP_VERSION=1.1.1")
    expect(dockerfile).toContain('amd64) browser_package="google-chrome-stable"')
    expect(dockerfile).toContain('arm64) browser_package="chromium"')
    expect(dockerfile).toContain("OpenRalph supports amd64 and arm64")
    expect(dockerfile).toContain("npm install --global chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}")
    expect(dockerfile).toContain("COPY container/bin ./bin")
    expect(dockerfile).toContain("COPY bin/openralph ./bin/openralph")
    expect(dockerfile).toContain("bun install --production --frozen-lockfile")
    expect(dockerfile).toContain("PATH=/opt/openralph/bin:/usr/local/bin")
    expect(dockerfile).toContain("chmod +x /opt/openralph/bin/chrome-devtools-mcp-wrapper /opt/openralph/bin/openralph")
    expect(dockerfile).toContain("google-chrome-stable")
    expect(dockerfile).toContain("chromium")
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
    expect(wrapper).toContain("OPENRALPH_BROWSER_BIN")
    expect(wrapper).toContain("google-chrome google-chrome-stable chromium chromium-browser")
    expect(wrapper).toContain('ready="true"')
    expect(wrapper).toContain('[ "${ready}" != "true" ]')
    expect(wrapper).toContain("chrome-devtools-mcp --browser-url=")
  })
})

describe("Docker image workflow", () => {
  test("publishes matching versioned GHCR images", async () => {
    const workflow = await readFile(join(import.meta.dir, "..", ".github", "workflows", "docker-image.yml"), "utf8")

    expect(workflow).toContain("ghcr.io/john-ezra/open-ralph")
    expect(workflow).toContain("linux/amd64,linux/arm64")
    expect(workflow).toContain("org.openralph.version=${{ steps.version.outputs.version }}")
    expect(workflow).toContain('EXPECTED_TAG="v${VERSION}"')
    expect(workflow).not.toContain(":latest")
  })
})

describe("pullDockerImage", () => {
  test("emits idle heartbeat while Docker pull is quiet", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-docker-test-"))
    const originalPath = process.env.PATH

    try {
      const bin = join(root, "bin")
      await mkdir(bin)
      const docker = join(bin, "docker")
      await writeFile(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "pull" ]; then
  sleep 0.08
  printf 'pull complete\n'
  exit 0
fi

printf 'unexpected docker args: %s\n' "$*" >&2
exit 2
`,
      )
      await chmod(docker, 0o755)
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`

      const output: Array<{ stream: string; chunk: string }> = []
      const result = await pullDockerImage({
        image: "openralph:test",
        cwd: root,
        streamOutput: false,
        captureOutput: true,
        idleStatusIntervalMs: 10,
        onOutput: (event) => output.push(event),
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("pull complete")

      const heartbeat = output.find((event) => event.chunk.includes("still pulling Docker image openralph:test"))
      expect(heartbeat?.stream).toBe("stderr")
      expect(heartbeat?.chunk).toContain("no Docker output for")
      expect(heartbeat?.chunk).toContain('after "Download complete"')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("runDockerLoop", () => {
  test("runs the container with masks and token, then cleans up temp files", async () => {
    await withFakeDockerRepo(
      `if [ "$1" = "run" ]; then
  printf '%s\\n' "$@" > "\${OPENRALPH_TEST_DOCKER_ARGS}"
  printf 'OpenRalph build complete: build complete\\n'
  exit 0
fi
exit 2
`,
      async ({ repo, authPath, argsFile }) => {
        const result = await runDockerLoop({
          phase: "build",
          rawArgs: "1",
          projectRoot: repo,
          options: {},
          docker: { enabled: true, image: "openralph:test", maskEnv: true },
          streamOutput: false,
          captureOutput: true,
          authPath,
        })

        expect(result.exitCode).toBe(0)
        expect(result.stopRequested).toBe(false)
        expect(result.stdout).toContain("OpenRalph build complete: build complete")

        const args = await readFile(argsFile, "utf8")
        expect(args).toContain("--name")
        expect(args).toContain("OPENRALPH_IN_DOCKER=1")
        expect(args).toContain("target=/workspace/.env,readonly")

        const mountSource = (target: string) =>
          args
            .split("\n")
            .find((line) => line.includes(`target=${target}`))
            ?.match(/source=([^,]+),/)?.[1]

        const tokenSource = mountSource("/run/openralph/docker-token")
        const maskSource = mountSource("/workspace/.env")
        expect(tokenSource).toBeDefined()
        expect(maskSource).toBeDefined()
        expect(existsSync(tokenSource as string)).toBe(false)
        expect(existsSync(maskSource as string)).toBe(false)
      },
    )
  })

  test("flags user stops via the abort signal instead of throwing", async () => {
    await withFakeDockerRepo(
      `if [ "$1" = "run" ]; then
  sleep 3
  exit 0
fi
exit 2
`,
      async ({ repo, authPath }) => {
        const controller = new AbortController()
        controller.abort()

        const result = await runDockerLoop({
          phase: "plan",
          rawArgs: "1",
          projectRoot: repo,
          options: {},
          docker: { enabled: true, image: "openralph:test", maskEnv: false },
          streamOutput: false,
          captureOutput: true,
          signal: controller.signal,
          authPath,
        })

        expect(result.stopRequested).toBe(true)
      },
    )
  })

  test("requires git identity before launching the container", async () => {
    await withFakeDockerRepo(
      `exit 2
`,
      async ({ repo, authPath }) => {
        await runCommand("git", ["config", "--unset", "user.name"], repo)
        await runCommand("git", ["config", "--unset", "user.email"], repo)

        await expect(
          runDockerLoop({
            phase: "build",
            rawArgs: "1",
            projectRoot: repo,
            options: {},
            docker: { enabled: true, image: "openralph:test", maskEnv: false },
            streamOutput: false,
            captureOutput: true,
            authPath,
          }),
        ).rejects.toThrow("require Git user.name and user.email")
      },
    )
  })
})

async function withFakeDockerRepo(
  dockerScriptBody: string,
  run: (context: { repo: string; authPath: string; argsFile: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openralph-dockerloop-test-"))
  const originalPath = process.env.PATH
  const originalArgsFile = process.env.OPENRALPH_TEST_DOCKER_ARGS
  const originalGitGlobal = process.env.GIT_CONFIG_GLOBAL
  const originalGitSystem = process.env.GIT_CONFIG_SYSTEM

  try {
    // Isolate git identity to the test repo so machine-level config cannot
    // satisfy requireGitIdentity.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    const bin = join(root, "bin")
    await mkdir(bin)
    const docker = join(bin, "docker")
    await writeFile(docker, `#!/usr/bin/env bash\nset -euo pipefail\n\n${dockerScriptBody}`)
    await chmod(docker, 0o755)

    const repo = join(root, "repo")
    await mkdir(repo)
    await runCommand("git", ["init"], repo)
    await runCommand("git", ["config", "user.name", "OpenRalph Test"], repo)
    await runCommand("git", ["config", "user.email", "openralph@example.com"], repo)
    await writeFile(join(repo, ".env"), "SECRET=1")

    const authPath = join(root, "auth.json")
    await writeFile(authPath, "{}")

    const argsFile = join(root, "docker-args.txt")
    process.env.OPENRALPH_TEST_DOCKER_ARGS = argsFile
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`

    await run({ repo, authPath, argsFile })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath

    if (originalArgsFile === undefined) delete process.env.OPENRALPH_TEST_DOCKER_ARGS
    else process.env.OPENRALPH_TEST_DOCKER_ARGS = originalArgsFile

    if (originalGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = originalGitGlobal

    if (originalGitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = originalGitSystem

    await rm(root, { recursive: true, force: true })
  }
}

describe("env masking", () => {
  test("classifies env files", () => {
    expect(shouldMaskEnvFile("/repo/.env")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.env.local")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.ENV")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.Env.Local")).toBe(true)
    expect(shouldMaskEnvFile("/repo/.env.example")).toBe(false)
    expect(shouldMaskEnvFile("/repo/.ENV.EXAMPLE")).toBe(false)
    expect(shouldMaskEnvFile("/repo/.env.sample")).toBe(false)
    expect(shouldMaskEnvFile("/repo/not-env")).toBe(false)
  })

  test("detects maskable env files recursively, including build output dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-test-"))
    try {
      const rootReal = await realpath(root)
      await mkdir(join(root, "nested"))
      await mkdir(join(root, "dist"))
      await mkdir(join(root, "node_modules"))
      await mkdir(join(root, ".git"))
      await writeFile(join(root, ".env"), "SECRET=1")
      await writeFile(join(root, ".env.example"), "SECRET=")
      await writeFile(join(root, ".ENV.LOCAL"), "SECRET=upper")
      await writeFile(join(root, "nested", ".env.production"), "SECRET=2")
      await writeFile(join(root, "dist", ".env"), "SECRET=copied-by-build")
      await writeFile(join(root, "node_modules", ".env"), "SECRET=skipped")
      await writeFile(join(root, ".git", ".env"), "SECRET=skipped")

      expect((await detectMaskableEnvFiles(root)).map((path) => containerPath(rootReal, path))).toEqual([
        "/workspace/.ENV.LOCAL",
        "/workspace/.env",
        "/workspace/dist/.env",
        "/workspace/nested/.env.production",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("masks the resolved target of in-repo .env symlinks and ignores outside targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "openralph-test-"))
    const outside = await mkdtemp(join(tmpdir(), "openralph-outside-"))
    try {
      const rootReal = await realpath(root)
      await writeFile(join(root, "real-secrets.txt"), "SECRET=real")
      await symlink(join(root, "real-secrets.txt"), join(root, ".env"))
      await writeFile(join(outside, "outside-secrets.txt"), "SECRET=outside")
      await symlink(join(outside, "outside-secrets.txt"), join(root, ".env.outside"))
      await symlink(join(root, "missing-target.txt"), join(root, ".env.broken"))

      expect((await detectMaskableEnvFiles(root)).map((path) => containerPath(rootReal, path))).toEqual([
        "/workspace/real-secrets.txt",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
