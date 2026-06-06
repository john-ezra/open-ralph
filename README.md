# OpenRalph

OpenRalph is a small opencode plugin and CLI for running a Ralph-loop-style workflow autonomously in a Docker container.

## Phases

- `define`: *interactive* - Work with the agent to ideate and clarify your idea. This produces a `specs/*` artifact.
- `plan`: *autonomous* - Consumes `specs/*` and breaks requirements into individual tasks. This produces `IMPLEMENTATION_PLAN.md`.
- `build`: *autonomous* - Reads `IMPLEMENTATION_PLAN.md` and handles one task at a time with fresh context for each child run.

## Commands

- `/ralph` opens the TUI selector for Design, Plan, and Build.
- `openralph plan` runs fresh planning iterations until the plan is stable.
- `openralph build` runs fresh build iterations, one task and one commit at a time.
- `openralph docker build` builds a local/custom runtime image.

## TUI Selector Options

- `Design` starts the define phase.
- `Plan` runs fresh planning iterations until the plan is stable.
- `Build` runs fresh build iterations, one task and one commit at a time.

## Flags (Optional)

```text
openralph plan [max] [--model <provider/model>] [--no-docker]
openralph build [max] [--model <provider/model>] [--push] [--no-docker]
openralph docker build [--tag <image>] [--no-cache]
```

## Installation

Install the npm package `@john-ezra/open-ralph` through opencode's plugin installer:

1. Open opencode in the target project.
2. Run `Install plugin` from the command palette/plugins UI.
3. Enter `@john-ezra/open-ralph` at the package name prompt.
4. Leave scope as `local`, or press `Tab` to toggle to `global`.
5. Run `/ralph`.

CLI equivalent:

```bash
opencode plugin @john-ezra/open-ralph
opencode plugin --global @john-ezra/open-ralph
```

Direct package execution with `bunx @john-ezra/open-ralph ...` or an installed `openralph` binary requires Bun.

## Workflow

Run `/ralph` from the opencode TUI and choose a mode:

- Design starts a requirements conversation and guides work toward planning-ready `specs/*.md` files.
- Plan updates `IMPLEMENTATION_PLAN.md` and commits it when planning reports completion.
- Build requires a clean worktree, implements one plan item, runs validation, and commits the result.

Plan and Build collect the same args as the CLI. Leave args empty for the default unlimited loop, or enter `1` for a bounded smoke test. Use Ctrl+C to stop an active loop.

Use a dedicated branch or disposable clone for autonomous Ralph runs. Build `--push` works only in host mode; Docker mode rejects it so you can review local commits before pushing.

## Project Setup

OpenRalph works best when the target project keeps a small set of clear disk artifacts:

- `specs/*`: behavioral requirements for Plan to compare against the codebase.
- `AGENTS.md`: operational notes, especially build/test/lint/typecheck commands and project conventions.
- `IMPLEMENTATION_PLAN.md`: the active work queue for the current Ralph initiative. Plan creates or updates it; Build consumes and maintains it across iterations. When the initiative is complete, delete, reset, or replace it before starting unrelated Ralph work.
- Validation: tests, typecheck, lint, and browser checks for UI work when practical.

Keep setup lean. If output is poor, improve validation or split plan items before adding prompt complexity.

## Configuration

Manual config is only needed when bypassing opencode's plugin installer or editing options directly. Add `@john-ezra/open-ralph` to both server and TUI config when needed.

- Server config: `opencode.json` with schema `https://opencode.ai/config.json`.
- TUI config: `tui.json` with schema `https://opencode.ai/tui.json`.
- Supported options: `defineModel`, `planModel`, `buildModel`, `docker.enabled`, `docker.image`, and `docker.maskEnv`.

Model precedence is:

```text
command --model -> OpenRalph config -> current TUI session model for /ralph Plan/Build -> opencode default
```

Direct CLI/headless runs can pass plugin options through `OPENRALPH_OPTIONS_JSON`. Without that env var, `openralph plan/build` uses defaults: Docker enabled, `.env*` masking enabled, and `ghcr.io/john-ezra/open-ralph:<installed-package-version>` as the runtime image.

Restart opencode after installing or changing `opencode.json`, `tui.json`, or plugin files.

## Docker Mode

Docker mode is the default for Plan and Build from `/ralph`, `openralph plan`, and `openralph build`. To run directly on the host, pass `--no-docker` or set `docker.enabled` to false.

When `docker.image` is omitted, OpenRalph uses `ghcr.io/john-ezra/open-ralph:<installed-package-version>`. It pulls that default image if missing, runs the container with `--pull=never`, and refuses stale or unlabelled images. Custom images are user-managed and are not pulled automatically.

On Windows, run OpenRalph from WSL2 with Docker Desktop's WSL integration enabled.

Build the default local image when you need an offline or project-custom runtime:

```bash
bunx @john-ezra/open-ralph docker build
```

If `openralph` is already on `PATH`, you can use:

```bash
openralph docker build
```

Use a custom tag when extending the image:

```bash
bunx @john-ezra/open-ralph docker build --tag openralph:rust
```

Example extension:

```Dockerfile
FROM openralph:local

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends cargo rustc \
  && rm -rf /var/lib/apt/lists/*

USER opencode
```

Build it with Docker, then set `docker.image` to the custom tag:

```bash
docker build -f Dockerfile.openralph -t openralph:rust .
```

The default image supports `linux/amd64` and `linux/arm64`. It includes opencode, Bun, Node 22, npm/npx/corepack, Git, Bash, curl, Python 3, native build tools, ripgrep, browser tooling, and screenshot-friendly fonts.

## Security

OpenRalph Plan and Build child iterations run `opencode run --dangerously-skip-permissions`. Treat agent actions as untrusted.

Docker mode reduces host filesystem exposure, but it is not a formal sandbox. The container can read and write the mounted repository, including `.git`; can read the mounted OpenCode auth file; and has unrestricted network egress. Docker mode masks files whose basename starts with `.env`, except `.env.example`, `.env.sample`, `.env.template`, and `.env.dist`. It does not mask other in-repo secrets such as `.npmrc`, private keys, cloud credentials, or service-account JSON.

Host mode runs child iterations directly on your machine with inherited environment variables, host filesystem access, and unrestricted network access. Use it only when you intentionally want that behavior.

Review changes before running host tools or pushing. Agent-written repository hooks or Git config can affect later host-side Git commands.

## Run Artifacts

Plan and Build write audit/debug artifacts under `runs/openralph-<phase>-YYYYMMDD-HHMMSS/`:

```text
runs/openralph-build-YYYYMMDD-HHMMSS/
  ralph.log
  iter-001.jsonl
  iter-001.txt
```

Artifacts are not loop state. Fresh child iterations rely on `specs/*`, `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, and the bundled prompts. Run artifacts may contain terminal output, command details, paths, and model text; do not commit or share them blindly.

## Development

For local development against this checkout, use relative file plugin specs:

```text
opencode.json plugin: ./src/plugin.ts
tui.json plugin: ./src/tui.ts
```

Validate changes with:

```bash
bun install
bun run validate
```
