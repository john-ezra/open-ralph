# OpenRalph

OpenRalph is a light opencode plugin that implements the Ralph workflow from Clayton Farr's Ralph Playbook.

## Core Principles

- Keep the implementation simple.
- Preserve Ralph's central mechanism: one fresh top-level opencode run per loop iteration.
- Use disk files as persistent state: `specs/*`, `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `PROMPT_plan.md`, and `PROMPT_build.md`; use `runs/*` only for durable local run artifacts and audit/debug output.
- Do not turn OpenRalph into a general sandbox or orchestration platform.
- Safety strategy is the user's responsibility. OpenRalph provides only lightweight guardrails and default Dockerized loop execution with explicit host-mode opt-out.
- Avoid complex modes, safety matrices, Podman requirements, or heavy process abstractions.

## Ralph Phases

- Phase 1: Define Requirements -> `/ralph` Design
- Phase 2: Planning -> `/ralph` Plan
- Phase 3: Building -> `/ralph` Build

Use these phase names consistently.

## Public Commands

- `/ralph`: the only public TUI slash command. It opens Design, Plan, and Build modes.
- `openralph plan` and `openralph build`: CLI/headless launcher entrypoints with the same public loop args.

## Internal Commands

- `/ralph-plan-iteration`: one fresh planning iteration.
- `/ralph-build-iteration`: one fresh build iteration/task.

The server plugin should inject these commands only for authorized loop child processes. Normal host TUI sessions must not expose internal iteration prompts.

## Loop Rules

- Plan/build loops launch child `opencode run` processes.
- Each child process handles one iteration with fresh top-level context.
- Never use `--continue` for child runs.
- Always pass `--dir <project-root>` to child runs.
- Plan/build child runs use `--dangerously-skip-permissions`.
- Docker mode is enabled by default; host plan/build commands launch one Docker container and the full loop runs inside it unless `--no-docker` or `docker.enabled: false` is used.
- Docker mode runs the container `openralph plan` or `openralph build` CLI entrypoint, never public prompt command replay.
- Container loops set `OPENRALPH_IN_DOCKER=1` and require token-backed Docker attestation before running.
- Docker mode disables project OpenCode config and injects config that loads only image-bundled OpenRalph.
- Docker mode injects a `chrome-devtools` MCP server into the container OpenCode config for browser validation.
- Docker mode runs containers with `--pull=never`, `--shm-size=1g`, and `--security-opt no-new-privileges:true`.
- The default image uses a non-root `opencode` user when Docker cannot run as the host UID/GID.
- Default max iterations is unlimited.
- Retry child process failures.
- Stop after 3 consecutive child process failures.
- Stop when Ralph reports completion.
- Ctrl+C is the manual stop mechanism.
- On first Ctrl+C, request shutdown, forward SIGINT to the active child process, and stop launching new iterations.
- On second Ctrl+C, force terminate the active child process and exit.
- User interrupt is not a child process failure and must not be retried.
- Push only when `--push` is passed and Docker mode is not used.
- Plan/build loops write project-local run artifacts under `runs/openralph-<phase>-YYYYMMDD-HHMMSS/`; artifacts must not replace `IMPLEMENTATION_PLAN.md` as the work queue.
- `runLoop()` must not independently launch Docker or inspect `docker.enabled`; the shared launcher resolves `docker-host-launch`, `host-explicit`, `host-config-default`, or `container-attested` once.

## Model Selection

Model selection is intentionally simple.

Precedence:

```text
command --model -> OpenRalph config -> opencode default
```

Plugin options:

```json
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
```

If no model is configured or passed, omit `--model` and let opencode use its default.

## Git Guardrails

- Require a Git worktree before running OpenRalph Plan or Build.
- Warn, but do not block, on `main` or `master`.
- Create lightweight namespaced Git tags after each successful clean build iteration.
- Tags are local by default.
- Do not push commits unless `--push` is passed.
- Do not push tags in v1 unless explicitly implemented later.

Recommended tag shape:

```text
openralph/build-YYYYMMDD-HHMMSS/001
openralph/build-YYYYMMDD-HHMMSS/002
```

Use tags only after a successful build iteration with a new commit and clean worktree.

## Development Git Workflow

- Do not make feature, fix, or improvement changes directly on `main`.
- Create a short-lived branch before editing, such as `feature/<name>` or `fix/<name>`.
- Keep `main` as the integration branch; merge reviewed/validated branch work back into `main`.
- Push branches for collaboration or backup, then merge to `main` only after validation passes.
- If accidental local edits happen on `main`, move them to a branch before committing unless the user explicitly approves a direct `main` commit.

## Safety Posture

OpenRalph v1 defaults to Dockerized execution for Plan and Build, with explicit host-mode opt-out.

Rationale:

- Ralph requires autonomy, so plan/build child runs use `--dangerously-skip-permissions`.
- Docker mode reduces host filesystem blast radius but is not a formal sandbox guarantee.
- TUI Design mode remains host-side so host memory/MCP integrations can participate in ideation.
- TUI Design mode is host-side and injects a Ralph Design prompt into the current session after an optional initial idea prompt.
- Docker mode mounts the repo read/write at `/workspace`, mounts OpenCode auth read-only, masks real `.env*` files by default, and does not mount host home, SSH, config, desktop sockets, or the Docker socket.
- Docker mode does not mount host Git config, SSH keys, GPG material, browser profiles, browser cookies, or desktop sockets.
- Dockerized OpenRalph Build requires host/project Git `user.name` and `user.email`; OpenRalph passes them through author/committer environment variables, disables commit/tag signing inside Docker, and marks `/workspace` as a safe Git directory.
- The default `openralph:local` image includes Bun, Node 22, npm/npx/corepack, Git, Bash, curl, Python 3, native build tools, ripgrep, Google Chrome stable, screenshot-friendly fonts, `opencode-ai@1.15.13`, and `chrome-devtools-mcp@1.1.1`.
- Chrome DevTools MCP runs through `/opt/openralph/bin/chrome-devtools-mcp-wrapper`, which starts isolated headless Chrome on a loopback debugging port with a temporary profile and connects MCP via `--browser-url`.
- The user still chooses their own isolation strategy and risk level.
- Recommended operator practice is to run on a dedicated branch or disposable clone.

## Implementation Preference

- Use TypeScript targeting Bun/opencode's plugin runtime.
- Keep the plugin small and deterministic.
- Prefer plain Markdown prompt/state files over JSON orchestration.
- Do not hardcode specific model IDs.
- Do not add additional public flags unless they are clearly necessary.
- Keep project setup guidance lean: validation commands, project conventions, and prioritized plan items matter more than prompt complexity.
- Do not add every language runtime to the default Docker image; projects needing Go, Rust, Java, databases, or other specialized tooling should extend `openralph:local`.
- Keep browser tooling Docker-only in v1; do not make Chrome DevTools MCP a host-side dependency.
- Public Design/Plan/Build commands are not prompt-backed `cfg.command` entries. The TUI plugin registers only `/ralph`; the server plugin deletes stale public command entries and throws if a stale prompt-backed public command is executed.

## References

- Ralph Playbook: https://github.com/ClaytonFarr/ralph-playbook
- Formatted guide: https://claytonfarr.github.io/ralph-playbook/
- opencode plugin docs: https://opencode.ai/docs/plugins/
- opencode command docs: https://opencode.ai/docs/commands/
