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

## How to run

### Discovery

`agentic-loop` is a standalone TypeScript CLI installed by the skills setup script. It is available as `agentic-loop` on your PATH — **not a pi skill, not an MCP tool, not an npm package.** If the command is not found, re-run the setup script from the skills repo.

```bash
agentic-loop --help
```

### Supported executors

The harness auto-detects `claude` or `pi` on PATH — no `--command` needed in most cases. Override with `--command` when using a specific model or non-standard binary.

- **`claude`** — Claude Code CLI, auto-detected if on PATH.
- **`pi`** — Pi CLI, used as fallback if `claude` is not found.

### Quick start

```bash
# Start a new goal (archives any existing agentic.json)
agentic-loop init "description of the goal"

# Run the loop with validation checks
agentic-loop run --checks "<test or build command>"

# Plan only — review agentic.json before executing
agentic-loop run --plan-only
```

### Key flags

| Flag | Effect |
|---|---|
| `--checks "cmd"` | Validation command run after each task |
| `--plan-only` | Planner runs but no executor — review agentic.json first |
| `--allow-dirty` | Skip clean-worktree gate |
| `--merge` | Auto-merge run branch into main |
| `--no-apply` | Keep changes on run branch, don't apply to working tree |
| `--tool claude` | Use claude instead of default agent |
| `--command "..."` | Custom agent invocation template (use `{prompt}` placeholder) |
| `--planner-command "..."` | Custom planner agent template |

### Check commands

Read `PROJECT.md` Commands and Verification Strategy sections for project-specific commands. Use the smallest targeted check that proves the changed behavior. Do not default to a package-wide or full smoke suite merely because it exists.

### Verification selection (mandatory)

Before choosing `--checks`, map:

```text
changed files → owning module/seam → affected callers → acceptance criterion → proof command
```

Use this escalation order:

1. docs/policy-only change: diff check, JSON/link validation, or relevant validator;
2. helper/admission change: focused unit/smoke assertion plus typecheck;
3. one loop phase: filtered end-to-end smoke plus typecheck;
4. CLI/transport/worktree change: filtered end-to-end smoke plus targeted integration check;
5. shared public contract, unknown impact, or release-critical change: broader suite.

Never run `all-smoke` or a complete smoke file automatically for a small
change. Run broad validation only when impact evidence justifies it, and state
the reason in the handoff. If broad validation is slow, flaky, or blocked by
the harness/environment, preserve the focused result and report the remaining
coverage gap instead of repeatedly rerunning the same broad command.

Validation handoff format:

```text
changed seam → command → result → remaining risk
```

Separate target-code failures from harness, environment, dependency, and
fixture failures. A broad suite that did not complete is not a full-confidence
result.

### After the run

The loop leaves changes as **unstaged diffs** in your working tree. Review with `git diff`, stage with `git add -p`, commit yourself. Nothing is committed automatically.

### Diagnostics

```bash
agentic-loop status        # task list + what's next
agentic-loop why-stuck     # explain blocked/needs_human tasks
agentic-loop last-failure  # most recent failure details

# Reset a stuck task and retry
agentic-loop reset-task <task-id> --apply
agentic-loop run
```

### You are inside Claude Code right now

Invoke the harness directly — do not do any planning, reading, or execution inline in the conversation:

```bash
agentic-loop init "the goal here"
agentic-loop run --checks "your check command"
```

After all tasks pass, changed files are applied to the main working tree as **unstaged changes** so you can review, stage, and commit manually. Claude Code's only job is to run these two commands.

### From a terminal

```bash
# Start a new goal
agentic-loop init "refactor the auth module to use JWT"

# Run — auto-detects claude or pi; applies result as unstaged changes at end
agentic-loop run --checks "npm test"

# Plan only — review agentic.json before executing
agentic-loop run --plan-only
agentic-loop run              # resume from the plan

# Opt into merge instead of apply (commits run branch into main)
agentic-loop run --merge --checks "npm test"
```

### Pre-flight validation (this repo only)

Before running an autonomous loop on this repository, verify the skill/README consistency:

```bash
agentic-loop validate
```

Stop and report violations if this exits non-zero.

## Worktree execution

Prefer one git worktree per executable task. The main repo stays clean; the harness creates `.worktrees/<task-id>/` on a dedicated branch, runs any configured worktree bootstrap commands, runs the executor there, runs checks, runs the verifier, and only then commits and merges. The harness — not the executor agent — marks tasks passed and merges branches. Use `--worktree-bootstrap`, `--worktree-bootstrap-ignore`, and `--check-env-file` when a target repo needs ignored local dependencies, generated code, embedded/FPGA tool outputs, SDK setup, or environment variables inside worktrees. Bootstrap is generic shell setup, not Node-specific.

For a full visual walkthrough of every phase and decision point, see [docs/agentic-loop-flow.md](../../../docs/agentic-loop-flow.md).

## Prompt contract

Executor prompts should include:

- the selected task JSON
- the selected workflow name
- the task-grill result for the current turn
- an instruction to read `AGENTS.md` / `CLAUDE.md`
- an instruction to read and follow the canonical `SKILL.md` for the selected workflow
- relevant `PROJECT.md`, `CONTEXT.md`, ADR, state, and recent progress references
- the rule that only one task may be completed
- the rule that the harness/verifier marks completion

Before each executor prompt, the harness should run a task-grill prompt that asks whether the current task is still understood, scoped, and safe. If the task-grill verdict is `needs_replan`, the stale task should be marked `blocked`, the planner should run again, and the loop should continue with replacement tasks.

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

After launching the harness, report:

- state file path and task count
- selected workflows per task
- checks being run
- expected worktree root
- any human gates or unresolved risks that caused a stop
- the exact harness command that was (or would be) run
