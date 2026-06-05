# Ralph Planning Iteration

0a. Study `specs/*` with up to 250 parallel research subagents to learn the application requirements.
0b. Study `IMPLEMENTATION_PLAN.md` if present; it may be incomplete or wrong.
0c. Study the current source code and project structure with up to 250 parallel research subagents before making plan changes.
0d. Study shared utilities, components, and existing patterns before recommending new ones.

1. Compare `specs/*` against the current implementation using up to 500 parallel research subagents for code search, reads, and gap analysis. Do not assume functionality is missing; confirm with code search first. Use one higher-reasoning subagent where useful to synthesize findings and prioritize the plan.

2. Create or update `IMPLEMENTATION_PLAN.md` as a prioritized list of remaining actionable work. Keep it up to date with items that are complete, incomplete, blocked, or discovered during research.

3. Consider TODOs, placeholder implementations, skipped or flaky tests, minimal stubs, inconsistent patterns, missing validation, missing backpressure, and audit findings from recent `runs/openralph-*` artifacts when available.

4. Plan only. Do not implement code. Do not commit. Do not push. Do not create tags.

5. If specs are missing or inconsistent, document the issue clearly. Only create or refine specs when necessary to unblock accurate planning, and keep specs behavioral rather than implementation-prescriptive.

99999. Important: capture the why when documenting tasks, tests, and implementation importance.
999999. Important: keep `AGENTS.md` operational only. Status, progress, and planning belong in `IMPLEMENTATION_PLAN.md`.

## IMPLEMENTATION_PLAN.md Hygiene

Treat `IMPLEMENTATION_PLAN.md` as the canonical prioritized checklist. Keep remaining actionable work sorted from highest to lowest value. Prefer tasks small enough for one build iteration when practical. If a task would require broad refactoring, unclear sequencing, or repeated retries, split it into smaller independently validatable tasks. Remove or clearly mark completed work. Remove stale, duplicated, or contradicted tasks. Blocked items must include the blocker and what would unblock them. Add discovered bugs, audit findings, validation gaps, and follow-up work in the correct priority position. Do not record progress in `AGENTS.md`.

When the specs, current code, and `IMPLEMENTATION_PLAN.md` have converged into a stable prioritized task list, print exactly:

RALPH_PLAN_COMPLETE

If more planning work remains, update `IMPLEMENTATION_PLAN.md` and exit without printing a completion sentinel so the outer loop can continue.
