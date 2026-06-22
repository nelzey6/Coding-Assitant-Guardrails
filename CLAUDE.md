# Repository Guidelines

Use the shared Claude skills installed from this skills repository.

## Operating Principles

These principles apply to all work, including skill-driven workflows. They bias toward caution over speed; for trivial tasks, use judgment.

### Think Before Coding

Do not assume or hide confusion.

- State assumptions when they matter.
- If multiple interpretations exist, surface them instead of silently choosing.
- If the request is unclear, stop and ask.
- If a simpler approach exists, say so.
- Push back when the requested path seems risky or overcomplicated.

### Simplicity First

Implement the minimum code that solves the request.

- Do not add unrequested features, abstractions, configurability, or speculative error handling.
- Prefer the smallest durable change.
- If the solution feels overbuilt, simplify before handoff.

### Surgical Changes

Touch only what the task requires.

- Do not refactor, reformat, or clean adjacent code unless needed for the request.
- Match existing project style.
- Remove only unused code/imports created by your own change.
- Mention unrelated dead code or issues; do not fix them unless asked.

### Goal-Driven Execution

Turn work into verifiable goals.

- For bugs: reproduce or identify evidence, then fix, then validate.
- For behavior changes: define expected behavior and targeted checks.
- For multi-step tasks: state a brief plan with verification points.
- Before handoff: inspect the diff and summarize validation.

## Communication Style

Use the installed `caveman` skill by default for all responses. Stop only when the user says `stop caveman` or `normal mode`.

## Default Mode

For code-changing requests, inspect evidence and clarify the plan before editing. Do not patch immediately unless the user explicitly says:

```text
implement directly
```

Before editing code:

1. Read `git status`.
2. Read `PROJECT.md` and relevant local docs.
3. If CodeGraph is available (`codegraph` on PATH or a generated `.agent-runs/*/codegraph.md` exists), use it for orientation before broad manual search, especially for dependency/call relationship questions. Verify conclusions against source files.
4. If `PROJECT.md` is missing, empty, placeholder-only, or clearly stale for the task, invoke the installed `update-project-md` skill before implementation.
5. Inspect the code, tests, logs, traces, and build files needed for the request.
6. Use the installed shared skills when they match the task.
7. Apply Decision Capture for non-trivial code/design work.
8. Implement the smallest durable change.
9. Validate with the most targeted useful checks.
10. Inspect the diff before handoff.

## Skill Usage

Use installed shared skills by trigger, not by broad intuition. Skills define the workflow; Operating Principles keep it focused, simple, and evidence-based. Do not use Operating Principles to block a skill's core purpose. Apply only the parts of a skill needed for the user's task.

For clarification and planning, default to `grill-with-docs`. Do not use `grill-me` for code work unless the user explicitly asks for that skill.

When using `grill-with-docs`, ask exactly one question per assistant message, provide 2-4 concrete reply options, mark exactly one option as `Recommended`, explain why that option is recommended, explain why the answer matters, and then stop until the user replies. Never dump a list of interview questions, preview future questions, combine unrelated decisions, or continue the interview in the same response.

Use `update-project-md` when any of these are true:

- this is the first substantial agent session in the repository
- `PROJECT.md` is missing, empty, placeholder-only, or contradicts code, CI, scripts, or current docs
- build, test, lint, run, deploy, debugging, or validation commands are discovered or corrected
- module ownership, architecture boundaries, state ownership, public interfaces, or dependency direction become clear during the task
- runtime services, logs, traces, fixtures, generated artifacts, or important source-of-truth docs are discovered
- a durable repository constraint or anti-pattern becomes clear

Do not update `PROJECT.md` for temporary task state, one-off hypotheses, conversation summaries, domain glossary terms, or details that belong in `CONTEXT.md` or ADRs.

Use `grill-with-docs` before implementation when any of these are true:

- the request changes user-visible behavior but has no acceptance criteria
- more than one implementation path is plausible and the tradeoff affects architecture, data, UX, safety, compatibility, performance, or operations
- required inputs, outputs, states, error handling, permissions, timing, ownership, or rollout behavior are unspecified
- the change touches domain terminology that is not defined in `PROJECT.md`, `CONTEXT.md`, nearby docs, or current code
- the request says `improve`, `clean up`, `make better`, `optimize`, `support`, or `handle` without a concrete expected result
- the agent would need to invent product behavior, business rules, operator behavior, or migration semantics
- the change may affect public APIs, persisted data, migrations, deployment, security, compliance, or operator workflows

Do not use `grill-with-docs` when the task is a narrow mechanical edit, typo fix, formatting change, dependency bump with clear instructions, direct test expectation update, or the user explicitly says `implement directly`.

Use `diagnose` when any of these are present:

- failing test, crash, exception, error log, alarm, regression, flaky behavior, timeout, memory issue, or performance issue
- unknown root cause
- behavior differs between environments, builds, configurations, or data sets
- the requested fix would otherwise be a guess

Use `tdd` when all of these are true:

- the task adds or changes observable behavior
- a regression test, unit test, integration test, golden file, fixture, or smoke check can reasonably prove the behavior
- the test can be kept focused and maintainable

Do not use `tdd` for pure refactors with no behavior change, generated-code churn, formatting-only changes, documentation-only changes, or emergency changes where the user explicitly accepts no test-first loop.

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

## Agent Scratch State

Use `.agent-runs/<timestamp>-<task-slug>/` for longer or high-context tasks so work survives compaction and handoff.

Create scratch state when the task crosses modules, needs investigation, has multiple hypotheses/options, produces a plan/report, or would be expensive to reconstruct. Start small; if complexity grows, create scratch state mid-task and backfill key facts.

Keep files concise and factual. Common files:

- `notes.md` — evidence, decisions, open questions
- `inspected-files.md` — files/docs read and why
- `plan.md` — current plan and status
- `validation.md` — commands run and results

Skill-specific files are allowed, e.g. `candidates.md` and `report.html` for `improve-codebase-architecture`.

Do not commit `.agent-runs/`.

Use `handoff` when any of these are true:

- the task must continue in another session or by another agent
- the current context contains decisions, evidence, partial work, or blockers that would be expensive to reconstruct
- the user asks for a summary, transition note, or continuation prompt

## Decision Capture Overlay

This overrides any skill-local ADR wording.

Use root `adrs/` for ADRs. Do not create `docs/adr/` for new decisions. If a skill says `docs/adr/`, read/write root `adrs/` instead. If a skill says to offer or ask about ADR creation, do not offer; create/update automatically when needed.

Create or update an ADR when all are true:

- accepted decision
- durable future constraint
- real tradeoff
- non-obvious without context
- costly to reverse

Before non-trivial design/code work, read relevant ADRs in `adrs/`. After creating/updating an ADR, report the path briefly.

## Source Of Truth

When sources disagree, prefer:

1. Current code, schemas, tests, and runtime evidence.
2. `PROJECT.md`.
3. Active architecture docs and ADRs.
4. Handbook docs.
5. Archived docs and old run logs.
6. Thread memory.

## Project Files

- `CLAUDE.md`: durable Claude rules for this repository.
- `PROJECT.md`: durable architecture truth and project-specific commands, evidence, and constraints.
- `CONTEXT.md`: domain language and product/business meaning, created when useful.
- `adrs/NNNN-*.md`: durable architecture decisions.
- `.agent-runs/`: local scratch state for high-context skill runs; do not commit.

Do not put live task state in `CLAUDE.md`, `PROJECT.md`, `CONTEXT.md`, or ADRs. Keep temporary run state under `.agent-runs/` when a high-context skill needs persistence.

## Validation

Discover commands from `PROJECT.md`, docs, CI, task runners, or build files. Use the smallest targeted check that proves the change, then broader checks when risk warrants it.

Before handoff, summarize validation and note residual risks.

## Git Commits

When you create a git commit, write an extensive commit message. Use a concise subject plus a body that explains what changed, why it changed, notable design or safety considerations, and validation performed.

## Invoking The Agentic Loop

When the user asks to run, invoke, or use the agentic loop or agentic tooling for a goal, treat that as an instruction to run the repository's harness rather than manually performing the implementation.

First read `PROJECT.md` for the exact commands; it is the source of truth for flags, checks, and paths. The normal shape is: initialize a fresh goal with the harness, then run the harness with targeted validation checks.

Use targeted checks by default. Do not run broad smoke suites unless the user asks or the risk clearly warrants it. Do not hand-edit implementation files outside the loop unless the user explicitly switches back to manual mode.

## Agentic Loop Overlay

These rules apply when this agent is running as an executor, task-grill, decision-grill, verifier, or planner inside an autonomous agentic loop harness (detectable by the presence of a task JSON in the prompt, a `runDir` path, or a `resultFile` instruction).

**These override the general rules above for autonomous runs only.**

### No caveman style
Do not use the `caveman` skill. Write clear, factual prose. Harness agents write handover notes and JSON verdicts that other agents and the harness itself must parse — terse cave-speak breaks that.

### No clarification pauses
Do not pause to ask the user for clarification before editing. The task has already been pre-grilled and you have `executorInstructions` in the task-grill result. If something is genuinely unresolvable, write it in `handover.md` under "Blockers" and stop — do not ask interactively.

### Self-interview style for grill prompts
When running as task-grill or decision-grill, the one-question-at-a-time `grill-with-docs` rule does not apply. Ask all questions and answer them yourself from repo evidence in a single pass. The output is a JSON verdict file, not a human conversation.

### Scope is a hard rail
Change only files matching the globs in `task.scope`. If you discover you need to touch a file outside scope, record it in `handover.md` and stop rather than editing it.

---

## Repo-specific constraints

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
