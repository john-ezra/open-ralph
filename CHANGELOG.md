# Changelog

All notable changes to OpenRalph will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

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
