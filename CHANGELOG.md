# Changelog

All notable changes to OpenRalph will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

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
