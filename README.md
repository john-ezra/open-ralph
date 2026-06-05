# OpenRalph

OpenRalph is a light opencode plugin/package that implements the Ralph workflow through TUI and CLI entrypoints:

- `/ralph`: the only public TUI slash command. It opens a Design, Plan, Build mode selector.
- `openralph plan [max] [--model <model>] [--no-docker]`: CLI/headless launcher for fresh planning iterations until `IMPLEMENTATION_PLAN.md` is stable.
- `openralph build [max] [--model <model>] [--push] [--no-docker]`: CLI/headless launcher for fresh build iterations, one task and one commit at a time.

## Installation

OpenRalph is distributed as the npm package `@john-ezra/openralph`. OpenRalph itself stays Bun/TypeScript-native. Direct package execution through `bunx @john-ezra/openralph ...` or an installed `openralph` binary requires Bun.

The normal install path is opencode's built-in plugin installer:

1. Open opencode in the target project.
2. Run `Install plugin` from the command palette/plugins UI.
3. Enter `@john-ezra/openralph` at the `npm package name` prompt.
4. Leave scope as `local` for a project install, or press `Tab` to toggle to `global`.
5. Build the default Docker image with `bunx @john-ezra/openralph docker build`.
6. Restart opencode if needed.
7. Run `/ralph`.

CLI equivalent for non-TUI users:

```bash
opencode plugin @john-ezra/openralph
opencode plugin --global @john-ezra/openralph
```

The opencode installer installs the npm package into opencode's plugin cache, detects both OpenRalph server and TUI targets, and patches the matching config files automatically. Local scope writes under `<worktree>/.opencode/` when run in a Git worktree; global scope writes under `~/.config/opencode/`.

## Advanced Manual Config

Manual config is only needed when you want to bypass opencode's plugin installer or edit plugin options directly. Use `@john-ezra/openralph` for both server and TUI config; do not configure `@john-ezra/openralph/tui` as the plugin name.

Server plugin in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@john-ezra/openralph",
      {
        "defineModel": "provider/heavy-model",
        "planModel": "provider/cheap-model",
        "buildModel": "provider/cheap-model",
        "docker": {
          "enabled": true,
          "image": "openralph:local",
          "maskEnv": true
        }
      }
    ]
  ]
}
```

TUI plugin in `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "@john-ezra/openralph",
      {
        "defineModel": "provider/heavy-model",
        "planModel": "provider/cheap-model",
        "buildModel": "provider/cheap-model",
        "docker": {
          "enabled": true,
          "image": "openralph:local",
          "maskEnv": true
        }
      }
    ]
  ]
}
```

All model options are optional. Command `--model` values override plugin options. For Plan and Build runs started from `/ralph`, OpenRalph uses the current TUI session's selected model as a final fallback before launching fresh child runs. Direct CLI/headless runs have no TUI-selected model available; if no model is resolved there, OpenRalph omits `--model` and lets opencode use its default.

Server and TUI plugin options use the same shape. Direct CLI/headless runs can pass the same launcher options through `OPENRALPH_OPTIONS_JSON`; without that env var, `openralph plan/build` uses default options, including Docker enabled with image `openralph:local` and `.env*` masking enabled.

## Docker Mode

Docker mode is the default for Plan and Build. Plan and Build from `/ralph`, `openralph plan`, and `openralph build` launch one Docker container from the host and run the full Ralph loop inside it through the container `openralph` CLI entrypoint. Docker uses `--pull=never`, so build the default image locally before running Dockerized loops. OpenRalph checks the image's stamped package version before launch and refuses stale or unlabelled images; rebuild the image after updating OpenRalph. To intentionally run on the host, pass `--no-docker` for that run or set `"docker": { "enabled": false }` in plugin options.

If you installed through opencode's plugin installer, the package bin may not be available on your shell `PATH`. Build the image with direct package execution:

```bash
bunx @john-ezra/openralph docker build
```

If the `openralph` binary is already on `PATH`, such as from a global package install, AUR/Omarchy install, or local checkout, you can use:

```bash
openralph docker build
```

Use a custom tag for the default image if desired:

```bash
bunx @john-ezra/openralph docker build --tag openralph:rust
```

Projects can extend the local image with a small Dockerfile:

```Dockerfile
FROM openralph:local

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends cargo rustc \
  && rm -rf /var/lib/apt/lists/*

USER opencode
```

Build it with Docker directly:

```bash
docker build -f Dockerfile.openralph -t openralph:rust .
```

Then point plugin options at that tag with `"docker": { "enabled": true, "image": "openralph:rust" }`.

The default image includes `opencode-ai@1.15.13`, Bun, Node 22, npm/npx/corepack, Git, Bash, curl, Python 3, native build tools, ripgrep, Google Chrome stable, screenshot-friendly fonts, and `chrome-devtools-mcp@1.1.1`.

Restart opencode after installing or changing `opencode.json`, `tui.json`, or plugin files. opencode loads plugin/config files only at startup.

## Security Posture

OpenRalph Plan and Build child iterations run `opencode run --dangerously-skip-permissions`. Treat the agent's actions as untrusted.

Host mode runs those child iterations directly on your machine with inherited environment variables, host filesystem access, and unrestricted network access. Use `--no-docker` or `"docker": { "enabled": false }` only when you intentionally want that behavior.

Docker mode reduces host filesystem blast radius, but it is not a formal sandbox. The agent can read the mounted repository and the read-only mounted OpenCode auth file, and Docker mode does not restrict network egress. The `.env*` masking feature only replaces files whose basename starts with `.env`, except `.env.example`, `.env.sample`, `.env.template`, and `.env.dist`; it does not mask other in-repo secrets such as `.npmrc`, private keys, cloud credentials, or service-account JSON.

Docker mode mounts the repository read/write, including `.git`, because Build must create commits inside the container. OpenRalph disables hooks and fsmonitor for Git commands it runs on the host, but your own host-side Git commands may still honor agent-written hooks or Git config after a Docker run. Use a disposable clone or dedicated branch for autonomous Ralph runs, review changes before running host tools, and push manually only after review.

## Local Development

For local development against this checkout, use relative file plugin specs instead of absolute machine paths:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["./src/plugin.ts", {}]]
}
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./src/tui.ts", {}]]
}
```

## Lean Project Setup

OpenRalph works best when the target project supplies a small set of clear disk artifacts:

- `specs/*`: behavioral requirements for Plan to compare against the codebase.
- `AGENTS.md`: operational contract only, especially build/test/lint/typecheck commands and important project conventions.
- `IMPLEMENTATION_PLAN.md`: prioritized mutable work queue maintained by Plan and Build.
- Validation backpressure: tests, typecheck, lint, and browser checks for UI work when practical.

Keep setup lean. If output is poor, improve validation or split plan items before expanding prompts or adding modes.

## TUI Usage

Run `/ralph` from the opencode TUI to open the Ralph mode selector. Select Design, Plan, or Build with the arrow keys.

Design opens an optional idea prompt. If you leave it blank, Ralph starts by asking what you are working on. If you enter an idea, Ralph starts the current host session with a design prompt that guides ideation toward planning-ready `specs/*.md` artifacts.

Plan and Build open an args dialog after you choose them from the `/ralph` menu. The dialog collects the same loop args as the CLI entrypoints.

The dialog placeholder is only an example. For bounded smoke tests, enter `1`. Leaving the dialog empty uses the default unlimited loop, though Ralph may still stop after one iteration when it reports completion.

When Plan or Build starts, OpenRalph opens the output viewer automatically so you can inspect recent Docker/opencode output without streaming raw child output into the TUI renderer. While a loop is active, the output viewer asks for confirmation: Confirm or Esc closes only the viewer, while Cancel stops the active loop.

## Run Artifacts

Plan and Build write durable project-local run artifacts under `runs/openralph-<phase>-YYYYMMDD-HHMMSS/`. OpenRalph creates `runs/.gitignore` so the artifacts stay out of normal Git status; you can also add `/runs/` to the target repo's tracked `.gitignore` if you want that ignore rule shared.

Typical shape:

```text
runs/openralph-build-YYYYMMDD-HHMMSS/
  ralph.log
  iter-001.jsonl
  iter-001.txt
```

Artifacts are audit/debug output, not loop state. Fresh child iterations still rely on `specs/*`, `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, and the static prompts.

Use artifacts as the backpressure audit trail. Review them for repeated failures, dangerous commands, unexpected sensitive path access, skipped validation, bad assumptions, or missing tests, then convert those findings into better tests, lint/typecheck rules, `AGENTS.md` operational notes, specs, or new `IMPLEMENTATION_PLAN.md` tasks.

Run artifacts may contain terminal output, command details, paths, and model text. Do not commit or share them blindly.

## Runtime Notes

- Plan and Build require a Git worktree.
- `/ralph` is the only public TUI slash command. It selects Design, Plan, and Build. Design is a current-session requirements conversation; Plan and Build are external launcher loops.
- Public prompt-backed Ralph commands are stale. OpenRalph deletes stale `ralph-define`, `ralph-plan`, and `ralph-build` command config entries when the server plugin loads and throws if one is executed anyway.
- `/ralph-plan-iteration` and `/ralph-build-iteration` are internal prompt-backed commands and are exposed only to authorized loop child processes.
- `main` and `master` produce a warning but are not blocked.
- Docker mode disables project OpenCode config inside the container and injects config that loads only image-bundled OpenRalph for internal child commands.
- Docker mode is enforced with runtime attestation: the host passes a random token through env and a read-only token-file mount, and the container refuses to run the loop if the token/evidence check fails.
- Docker mode injects a `chrome-devtools` MCP server for browser validation. The MCP server uses `/opt/openralph/bin/chrome-devtools-mcp-wrapper`, which starts isolated headless Chrome on a loopback debugging port and connects via `--browser-url`.
- The default image uses a non-root `opencode` user when Docker cannot run as the host UID/GID.
- Docker mode mounts the repo read/write at `/workspace`, mounts host OpenCode auth read-only but readable by the agent, and masks real `.env*` files by default.
- `.env.example`, `.env.sample`, `.env.template`, and `.env.dist` remain visible in Docker mode.
- Docker mode does not restrict network egress.
- `.env*` masking is best-effort and does not cover other in-repo secret files such as `.npmrc`, private keys, cloud credentials, or service-account JSON.
- Docker mode does not mount host home, host OpenCode config, Git config, SSH keys, GPG material, browser profiles, browser cookies, desktop sockets, or the Docker socket.
- Dockerized OpenRalph Build requires host/project Git `user.name` and `user.email`. OpenRalph passes those values as author/committer env vars, disables commit/tag signing inside Docker, and rejects `--push` in Docker mode.
- Child iterations run `opencode run --dir <project-root> --command <internal-command> --dangerously-skip-permissions`.
- Docker mode runs `openralph plan` or `openralph build` inside the container. It never replays public prompt-backed Ralph commands.
- Child iterations never use `--continue`.
- Plan and Build persist project-local run artifacts under `runs/openralph-<phase>-YYYYMMDD-HHMMSS/` for audit/debug output.
- Ctrl+C is the manual stop mechanism.
- OpenRalph Build with `--push` pushes commits only in host mode. Docker mode rejects `--push`; review local commits on the host before pushing.
- Use `--no-docker` to intentionally run a loop on the host when Docker mode is enabled.
- Build tags are local lightweight tags shaped like `openralph/build-YYYYMMDD-HHMMSS/001`.
- Frontend or web UI build tasks should validate in a browser when practical, using the Docker-provided Chrome DevTools MCP tools for screenshots, console errors, desktop/mobile layout checks, and browser-visible issues.
- If a build task stalls repeatedly, stop the loop and split the plan item; retries are not a substitute for smaller tasks.

Use a dedicated branch or disposable clone for autonomous Ralph runs. Docker mode reduces host filesystem blast radius, but it is not a formal sandbox guarantee.

## Verified Smoke Tests

The Docker/TUI migration was smoke-tested with `opencode-ai@1.15.13` using a disposable fixture repo.

- OpenRalph Plan selected from `/ralph` ran Docker with token attestation, produced `IMPLEMENTATION_PLAN.md`, and emitted `RALPH_PLAN_COMPLETE`.
- OpenRalph Build selected from `/ralph` with args `1` ran Docker with token attestation, implemented one greeting task, passed `npm test`, and created a commit in the fixture repo.
- Spoofed Docker markers and a direct container run without the mounted attestation token both failed before `runLoop()`.
- Build tags are created only when the worktree is clean after a successful build commit; an untracked local `tui.json` in the fixture correctly prevented tagging.

## Development

```bash
bun install
bun run validate
```
