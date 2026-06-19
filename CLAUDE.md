**REQUIRED: Before any work, read `templates/AGENTS.md` and `templates/CLAUDE.md` and follow all rules in both files.**

Skills are organized into bucket folders under `skills/`:

- `engineering/` — daily code work
- `productivity/` — daily non-code workflow tools
- `misc/` — kept around but rarely used
- `personal/` — tied to my own setup, not promoted
- `in-progress/` — drafts not yet ready to ship
- `deprecated/` — no longer used

Every skill in `engineering/`, `productivity/`, or `misc/` must have a reference in the top-level `README.md` and an entry in `.claude-plugin/plugin.json`. Skills in `personal/`, `in-progress/`, and `deprecated/` must not appear in either.

Each skill entry in the top-level `README.md` must link the skill name to its `SKILL.md`.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`.

Hard upstream-sync rule: do not modify files or skills that come unchanged from the original `mattpocock/skills` repository. This repo is merged from upstream regularly, so upstream-owned content must stay merge-friendly. Put local behavior, custom orchestration, and new workflows in clearly local files/skills/templates instead of editing upstream-derived files. If a change appears to require editing an upstream-derived file, stop and ask first, explaining the upstream merge risk and proposing a local overlay alternative.

---

## Skill Usage

Use installed shared skills by trigger, not by broad intuition. Skills define the workflow; apply only the parts needed for the user's task.

Use `grill-with-docs` before implementation when any of these are true:

- the request changes user-visible behavior but has no acceptance criteria
- more than one implementation path is plausible and the tradeoff affects architecture, data, UX, safety, compatibility, performance, or operations
- required inputs, outputs, states, error handling, permissions, timing, ownership, or rollout behavior are unspecified
- the change touches domain terminology not defined in `PROJECT.md`, `CONTEXT.md`, nearby docs, or current code
- the request says `improve`, `clean up`, `make better`, `optimize`, `support`, or `handle` without a concrete expected result
- the agent would need to invent product behavior, business rules, operator behavior, or migration semantics
- the change may affect public APIs, persisted data, migrations, deployment, security, compliance, or operator workflows

Do not use `grill-with-docs` for narrow mechanical edits, typo fixes, formatting changes, dependency bumps with clear instructions, or when the user says `implement directly`.

Use `diagnose` when any of these are present:

- failing test, crash, exception, error log, regression, flaky behavior, timeout, memory issue, or performance issue
- unknown root cause
- behavior differs between environments, builds, configurations, or data sets
- the requested fix would otherwise be a guess

Use `tdd` when all of these are true:

- the task adds or changes observable behavior
- a regression test, unit test, integration test, golden file, fixture, or smoke check can reasonably prove the behavior
- the test can be kept focused and maintainable

Do not use `tdd` for pure refactors with no behavior change, formatting-only changes, documentation-only changes, or when the user explicitly accepts no test-first loop.

Use `zoom-out` when any of these are true:

- the touched code is unfamiliar
- the change crosses modules, packages, services, process boundaries, or lifecycle phases
- ownership, state flow, dependency direction, or public interface boundaries are unclear
- the fix risks adding a local workaround instead of addressing the owning abstraction

Use `improve-codebase-architecture` when any of these are true:

- the main task is architecture cleanup, simplification, modularization, or boundary repair
- the change would add another layer, adapter, flag, conditional path, or parallel mechanism
- the implementation exposes duplicated ownership, unclear state ownership, circular dependencies, or repeated patches around the same seam
- there is a realistic chance to delete, collapse, or move code instead of adding more code

Use `update-project-md` when any of these are true:

- `PROJECT.md` is missing, empty, placeholder-only, or contradicts code, CI, scripts, or current docs
- build, test, lint, run, deploy, debugging, or validation commands are discovered or corrected
- module ownership, architecture boundaries, state ownership, public interfaces, or dependency direction become clear during the task
- a durable repository constraint or anti-pattern becomes clear

Use `handoff` when:

- the task must continue in another session or by another agent
- the current context contains decisions, evidence, partial work, or blockers that would be expensive to reconstruct
- the user asks for a summary, transition note, or continuation prompt

## Decision Capture

Use root `adrs/` for ADRs. Do not create `docs/adr/` for new decisions. Create or update an ADR when all are true: accepted decision, durable future constraint, real tradeoff, non-obvious without context, costly to reverse.

## Agentic Loop Overlay

When running as an executor, task-grill, decision-grill, verifier, or planner inside an autonomous agentic loop harness (detectable by the presence of a task JSON in the prompt, a `runDir` path, or a `resultFile` instruction):

- Do not use the `caveman` skill. Write clear, factual prose.
- Do not pause to ask the user for clarification. If something is genuinely unresolvable, write it in `handover.md` under "Blockers" and stop.
- When running as task-grill or decision-grill, ask all questions and answer them yourself from repo evidence in a single pass. Output is a JSON verdict file, not a conversation.
- Change only files matching the globs in `task.scope`. If you need to touch a file outside scope, record it in `handover.md` and stop.
