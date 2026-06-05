# Ralph Build Iteration

0a. Study `specs/*` with up to 500 parallel research subagents to understand the required behavior.
0b. Study `IMPLEMENTATION_PLAN.md`.
0c. Study current source code and shared project patterns before making changes.
0d. Study `AGENTS.md` for build, test, lint, typecheck, and operational guidance.

1. Choose the most important actionable item from `IMPLEMENTATION_PLAN.md`.

2. Before editing, search the codebase with up to 500 parallel research subagents for searches, reads, and context gathering. Do not assume functionality is missing; confirm the current state first. Use higher-reasoning subagents only for complex debugging or architectural decisions.

3. Implement exactly one coherent task from the plan. Keep the change complete, minimal, and consistent with existing project patterns.

3a. If the chosen task is too large or unclear to complete cleanly in one iteration, split or clarify it in `IMPLEMENTATION_PLAN.md`, document what should happen next, and stop rather than doing a partial implementation.

4. Run the relevant validation from `AGENTS.md`, including targeted tests for the changed unit when available. Use only 1 validation subagent at a time for build/tests so validation creates clear backpressure. Fix failures caused by the change before proceeding.

4a. For frontend or web UI tasks, validate in a browser when practical. Start the app, inspect desktop and mobile layouts, check console errors, and use screenshots or visual inspection for layout/design issues before committing.

5. If unrelated failures or bugs are discovered, either resolve them if they are part of the current increment or document them in `IMPLEMENTATION_PLAN.md`.

5a. If the iteration exposes a validation gap, unsafe operation pattern, repeated failure mode, or missing backpressure, document a concrete follow-up in `IMPLEMENTATION_PLAN.md` or a brief reusable operational note in `AGENTS.md`.

6. Keep `IMPLEMENTATION_PLAN.md` up to date. Remove or mark completed work, add discovered follow-up work, and document blockers.

7. Update `AGENTS.md` only for brief operational learnings, such as correct commands or important run/build notes. Do not use it as a progress log.

8. Before committing, update `IMPLEMENTATION_PLAN.md` so the next fresh iteration can choose the next most important task without relying on prior context. When validation passes and the task is complete, commit the changes with a concise message. After `git commit` succeeds, confirm `git status --short` is clean. Only then mark commit-related todos complete. Do not push. Do not create tags.

9. If you completed and committed one task in this iteration, print exactly this standalone final line, even if that task was the last actionable item:

RALPH_ITERATION_COMPLETE

10. If this iteration starts with no actionable tasks remaining, ensure `IMPLEMENTATION_PLAN.md` reflects that state, confirm `git status --short` is clean, and print exactly this standalone final line:

RALPH_COMPLETE

11. If work cannot continue because of a real blocker, document the blocker in `IMPLEMENTATION_PLAN.md` and print exactly:

RALPH_BLOCKED

99999. Important: capture the why when authoring documentation, tests, and implementation notes.
999999. Important: single sources of truth; avoid placeholder implementations and ad-hoc copies.
9999999. Important: keep `AGENTS.md` operational only. Status and progress belong in `IMPLEMENTATION_PLAN.md`. Do not use Ralph sentinel strings in todos or prose; reserve exactly one standalone sentinel for the final output line.

## IMPLEMENTATION_PLAN.md Hygiene

Treat `IMPLEMENTATION_PLAN.md` as the canonical prioritized checklist. Keep remaining actionable work sorted from highest to lowest value. Completed items should be removed or clearly marked complete. Blocked items must include the blocker and what would unblock them before printing `RALPH_BLOCKED`. Add discovered bugs, audit findings, validation gaps, and follow-up work in the correct priority position. Remove stale, duplicated, or contradicted tasks. If the plan becomes noisy or large, clean completed/stale entries while preserving remaining work and blockers. Do not record progress in `AGENTS.md`.
