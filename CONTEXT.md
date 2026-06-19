# Coding Assistant Guardrails — Domain Language

This file defines the canonical terms used across this repository. Use these names consistently in code, docs, prompts, and issues.

## Harness and run lifecycle

**Agentic loop** (or **harness**):
The TypeScript CLI (`tools/agent-loop/`) that orchestrates an autonomous coding run end-to-end — planning, grilling, executing, verifying, and applying results.

**Run**:
One invocation of `agentic-loop run`. A run processes all tasks for the current goal and ends by applying changes or reporting a stop condition. A run has one shared run worktree for its lifetime.

**Run worktree**:
The isolated git worktree created at the start of a run, at `.worktrees/run-<timestamp>/` on branch `agentic/run-<timestamp>`. All tasks in the run commit onto this branch. Cleaned up (or applied) when the run ends.

**Apply** (default end-of-run behavior):
After all tasks pass, the harness checks out the run branch into the main working tree as unstaged changes — no commit, no merge. The user reviews, stages selectively, and commits manually.

**Goal**:
The plain-English description of what the run should accomplish, stored in `agentic.json`. Set with `agentic-loop init "<goal>"`.

**Task**:
One discrete unit of work inside a run. Stored in `agentic.json` with an id, title, workflow, acceptance criteria, scope globs, validation commands, and status.

**Task status**:
One of: `pending`, `running`, `passed`, `failed`, `needs_retry`, `needs_human`, `blocked`.

## Phases

**Planner**:
The first agent phase. Reads the goal and repo, runs `grill-with-docs` discovery, and writes a task graph to `agentic.json` plus `grill-transcript.md`.

**Task-grill**:
A fresh agent that re-reads repo state before every executor turn and answers: "Is this task still understood, scoped, and safe?" Returns a structured verdict (`ready`, `needs_replan`, `needs_human`, `blocked`).

**Decision-grill**:
A fresh agent that surfaces genuine design forks before the executor acts. Each decision requires 2–4 evidenced options, exactly one recommended. Accepted decisions become **binding rules** injected into the executor prompt.

**Executor**:
The agent that does the actual code work. Runs inside the shared run worktree and follows the canonical `SKILL.md` for the selected workflow.

**Scope rail**:
Harness-owned check after executor and before verifier. Diffs changed files against the task's declared `scope` globs. Out-of-scope changes are a retryable failure.

**Verifier**:
A fresh agent that reviews the diff, check output, and acceptance criteria and returns `pass`, `fail`, or `needs_human`. High-risk tasks use multi-vote adversarial verifiers (told to refute first; majority pass required).

**Post-task review**:
After each passed task: a fresh agent checks whether the remaining task graph is still valid. Verdicts: `continue`, `adjust_remaining_tasks`, `replan`, `needs_human`.

**Architect checkpoint**:
Every N passed tasks (default 3): a broader review of the cumulative diff against the original goal. May force a replan.

## Workflows

**Workflow**:
The canonical skill the executor follows for a given task. Selected by the planner based on task kind. Common values: `tdd`, `diagnose`, `zoom-out`, `improve-codebase-architecture`, `grill-with-docs`, `prototype`.

**Skill**:
A reusable agent workflow packaged as a folder under `skills/` with a `SKILL.md` defining its trigger conditions, inputs, outputs, and step sequence. Usable standalone or selected by the agentic loop.

## Key artifacts

**`agentic.json`**: Task graph and loop state for the current goal.

**`grill-transcript.md`**: Planner's evidence-based Q&A audit trail — visible record of what was decided and why.

**`task-grill-result.json`**: Structured readiness verdict from the task-grill phase.

**`decision-grill-result.json`**: Structured design decisions from the decision-grill phase.

**`executor.md`**: Prompt handed to the executor. Includes task JSON, binding decisions, task-grill result, and scope.

**`verifier-result.json`**: Verifier verdict — `pass`, `fail`, or `needs_human`.

**`handover.md`**: Continuation note written by the executor or harness for the next agent turn.

**`failure-analysis.json`**: Phase, attempt, reason, and diff-stat on every failure — injected into the next task-grill to break blind-retry loops.

## Relationships

- A **Goal** has one **`agentic.json`** with many **Tasks**
- A **Run** processes all pending tasks for the current goal in one **Run worktree**
- Each **Task** goes through: Task-grill → Decision-grill → Executor → Scope rail → Checks → Verifier → Post-task review
- **Binding decisions** flow from Decision-grill into the Executor prompt as hard rules
- **Failure analysis** flows from each failed attempt into the next Task-grill prompt
