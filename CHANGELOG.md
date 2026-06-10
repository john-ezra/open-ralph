# Changelog

All notable changes to OpenRalph will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

### Fixed

- Stopped launching a new child iteration when a stop request or abort arrives between iterations, and killed children spawned inside the stop window.
- Read Ralph sentinels from stdout only, stripped ANSI escapes, and accepted sentinels only near the end of output so echoed prompts, quoted text, and stderr diagnostics can no longer complete or block a run.
- Parsed Docker-mode results from the inner loop's stdout status line: heartbeat lines are no longer mistaken for summaries, and the launcher status now reflects `stopped`, `max-reached`, and `blocked` instead of always reporting `complete`.
- Treated user-initiated Docker stops as a clean `stopped` outcome instead of a wrapped failure with exit code 1.
- Masked symlinked `.env*` files whose targets resolve inside the repository, scanned build-output directories for `.env*` files (only `.git` and `node_modules` are skipped), and matched `.env` names case-insensitively.
- Aligned `PROMPT_build.md` step 3a with the loop contract: plan-only refinements commit and print `RALPH_ITERATION_COMPLETE` instead of stopping without a sentinel.

### Added

- Stopped runs after 3 consecutive blocked iterations without new commits, with a new `blocked` loop status that exits the CLI non-zero.
- Exited the CLI with code 130 (128+SIGINT) for user-stopped runs so wrapping scripts do not mistake an interrupted run for a completed one; `max-reached` still exits 0 because bounded runs reach it intentionally.
- Counted plan iterations that neither print the sentinel nor change `IMPLEMENTATION_PLAN.md` as failures so idle planning cannot loop forever.
- Escalated SIGINT to SIGTERM/SIGKILL when an aborted child ignores the first signal, named loop containers, and force-killed the container on a second Ctrl+C in Docker mode.
- Honored OpenRalph plugin options from the project `opencode.json` for CLI and TUI runs, with `OPENRALPH_OPTIONS_JSON` and TUI options taking per-key precedence.
- Added a `/ralph` "View Active/Last Run" menu entry and a completion toast when a run finishes while the output viewer is closed.
- Added a CI workflow running `bun run validate` on pushes and pull requests, and gated Docker image publishing on the same validation.
- Extended the release check with package.json/CHANGELOG version consistency and detection of home-directory paths from any developer machine.
- Added sentinel-hygiene guardrails to `PROMPT_plan.md`.

## [0.3.4] - 2026-06-06

### Fixed

- Required `RALPH_PLAN_COMPLETE` to appear as a standalone line before Plan treats it as a completion sentinel.

## [0.3.3] - 2026-06-06

### Fixed

- Required a fresh planning iteration to review `IMPLEMENTATION_PLAN.md` changes before accepting `RALPH_PLAN_COMPLETE`.

## [0.3.2] - 2026-06-06

### Changed

- Updated public documentation and development branch workflow guidance.

## [0.3.1] - 2026-06-06

### Fixed

- Committed `IMPLEMENTATION_PLAN.md` automatically after planning reports completion.
- Improved Docker preparation status output and Plan/Build preflight handling.

## [0.3.0] - 2026-06-05

### Changed

- Renamed the public package and Docker image to `@john-ezra/open-ralph` and `ghcr.io/john-ezra/open-ralph`.
- Updated package metadata and docs for the scoped npm package.

## [0.2.1] - 2026-06-05

### Added

- Heartbeat output while Plan/Build child `opencode run` processes are quiet, without adding heartbeat lines to iteration transcripts.

## [0.2.0] - 2026-06-05

### Added

- Versioned prebuilt Docker image support for `ghcr.io/john-ezra/open-ralph:<package-version>`.
- Automatic pull of the matching default prebuilt Docker image when it is missing locally.
- GitHub Actions workflow for publishing multi-platform `linux/amd64` and `linux/arm64` images to GHCR.

### Changed

- Omitted `docker.image` now defaults to the versioned prebuilt image for the installed OpenRalph package version.
- `openralph docker build` still defaults to `openralph:local` for local/offline/custom images.
- Docker image builds now stamp the OpenRalph package version, and Dockerized Plan/Build refuse to run stale or unlabelled images.
- Default Docker image builds now support both `linux/amd64` and `linux/arm64`, using Google Chrome on amd64 and Chromium on arm64 for browser validation.

## [0.1.2] - 2026-06-04

### Changed

- Docker mode is now the default for Plan and Build; host mode requires `--no-docker` or `docker.enabled: false`.
- Missing default Docker images now fail before container launch with build and host-mode opt-out guidance.

### Fixed

- Normalized the CLI bin path so npm preserves the `openralph` executable during publish.

## [0.1.1] - 2026-06-04

### Fixed

- Kept opencode plugin type definitions out of runtime dependencies.

## [0.1.0] - 2026-06-04

### Added

- Initial public release of the OpenRalph opencode plugin and CLI.
- TUI `/ralph` command with Design, Plan, and Build modes.
- `openralph plan` and `openralph build` CLI/headless loop entrypoints.
- Optional attested Docker mode for Plan and Build loops.
- Docker `.env*` masking with example/template env files preserved.
- Local lightweight build tags for successful clean build commits.
