---
name: agentic-loop
description: Prepare or run an autonomous coding loop that reuses this repo's manual workflow policy: grill-with-docs discovery by default, route tasks to canonical skills, execute in worktrees, verify, reflect, and stop at human gates.
---

# Agentic Loop

Use this skill when the user wants a goal-driven autonomous coding loop, or wants to prepare work for one.

This skill does **not** replace `grill-with-docs`, `diagnose`, `tdd`, `zoom-out`, `improve-codebase-architecture`, `update-project-md`, or `handoff`. Those skills remain the canonical workflow definitions. This skill describes how an autonomous harness should route between them without duplicating their semantics.

## Shared workflow policy

Use `.agent-policy/workflow-policy.json` when it exists. If it is missing, use `templates/agent-policy/workflow-policy.json` from this skills repo as the reference policy.

The policy is the machine-readable routing layer:

- which canonical skill to choose
- when to choose it
- which human gates stop autonomous execution
- which verifier rules apply
- which scratch/worktree paths are expected

The policy is **not** the source of procedural skill behavior. When a workflow is selected, read and follow that workflow's `SKILL.md`.

## Default autonomous shape

A good autonomous run uses these phases:

1. **Discovery** — use `grill-with-docs` style discovery by default.
2. **Planning** — split the goal into small tasks, each with one selected workflow.
3. **Execution** — run one task in an isolated git worktree.
4. **Verification** — check the diff, acceptance criteria, configured commands, and human gates.
5. **Reflection** — update state with lessons, follow-up tasks, blockers, and handoff notes.

The harness should control rails and state. The LLM should do reasoning inside each rail.

## State file

Prefer `agentic.json` for autonomous state. A minimal state looks like:

```json
{
  "version": 1,
  "goal": "",
  "maxIterations": 10,
  "checks": [],
  "tasks": [],
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "promptPolicy": {
    "lessons": []
  }
}
```

Each task should include:

```json
{
  "id": "task-001",
  "title": "Small vertical task",
  "status": "pending",
  "workflow": "tdd",
  "priority": 1,
  "acceptanceCriteria": [],
  "validation": [],
  "dependsOn": []
}
```

Allowed statuses:

- `pending`
- `running`
- `passed`
- `failed`
- `needs_retry`
- `needs_human`
- `blocked`

## Discovery rules

Start from `grill-with-docs` unless the task is a narrow mechanical edit.

For autonomous mode, adapt the interview into an evidence-first decision gate:

1. Restate the goal.
2. Identify missing product, domain, architecture, safety, or validation decisions.
3. Inspect repo docs/code before asking the user.
4. Record answers found from the repo as decisions or assumptions.
5. Stop with `needs_human` only for unresolved decisions that the model must not invent.
6. If no human-blocking decision remains, create or update the task plan.

## Routing rules

Use the workflow policy's canonical skill mapping. In short:

- `grill-with-docs` for ambiguous goals, missing acceptance criteria, domain language, or product decisions.
- `diagnose` for bugs, failures, regressions, flakes, crashes, timeouts, or unknown root cause.
- `tdd` for clear observable behavior that can be proven with focused tests/checks.
- `zoom-out` before editing unfamiliar or broad areas.
- `improve-codebase-architecture` for structural changes, coupling, migration seams, and boundary repair.
- `update-project-md` when durable repo facts are discovered or changed.
- `handoff` when blocked, stopped, or human input is required.

Do not copy these skills' detailed procedures into loop prompts. Tell the agent to read and follow the canonical installed skill.

## Harness

For full autonomous execution, prefer the harness when it exists:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --goal "..." --checks "npm test"
```

or with another CLI:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool custom --command 'my-agent run --prompt-file {prompt}'
```

Do not start a multi-iteration autonomous harness unless the user explicitly asks to run it. If the harness is unavailable, use this skill to prepare or update `agentic.json` and report the intended harness command.

## Worktree execution

Prefer one git worktree per executable task:

```text
main repo stays clean
↓
create .worktrees/<run-task>/ on a task branch
↓
run executor agent in that worktree
↓
run checks in that worktree
↓
run verifier
↓
commit and merge only after verifier passes
↓
remove or retain worktree according to cleanup policy
```

The harness, not the executor agent, should mark tasks passed and merge branches.

## Prompt contract

Executor prompts should include:

- the selected task JSON
- the selected workflow name
- an instruction to read `AGENTS.md` / `CLAUDE.md`
- an instruction to read and follow the canonical `SKILL.md` for the selected workflow
- relevant `PROJECT.md`, `CONTEXT.md`, ADR, state, and recent progress references
- the rule that only one task may be completed
- the rule that the harness/verifier marks completion

Verifier prompts should include:

- task JSON and acceptance criteria
- selected workflow
- git diff/stat
- validation command output
- human gates from the workflow policy
- required JSON verdict: `pass`, `fail`, or `needs_human`

## Stop conditions

Stop and use `handoff` when:

- a human gate is crossed
- product/domain decision is unresolved
- validation cannot be run or interpreted safely
- verifier returns `needs_human`
- retry budget or iteration budget is exhausted
- the loop would need to edit upstream-derived files without explicit permission

## Final response

When preparing an agentic loop, report:

- state file path
- selected default checks
- task count and selected workflows
- expected worktree root
- human gates or unresolved risks
- suggested command for the harness when available
