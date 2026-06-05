# Todo

## Deferred Security Hardening

- [ ] Reduce container image filesystem permissions from broad `0777` on `/home/opencode` and `/workspace` to a narrower group/user strategy that still supports arbitrary host UID/GID mapping.
- [ ] Pin the Docker base image by digest and make global image installs more reproducible/tamper-evident.
- [ ] Consider an optional Docker network-restricted profile for users who can provide model access through a controlled proxy or local endpoint.
- [ ] Consider broadening best-effort secret masking beyond `.env*` after defining a low-surprise allowlist/denylist strategy.

## Follow-Up Validation

- [ ] After the next `openralph:local` Docker image rebuild, re-run the fixture smoke test and confirm Plan no longer reads the active `runs/openralph-*` artifact directory. If it still does, harden enforcement beyond prompt guidance.
