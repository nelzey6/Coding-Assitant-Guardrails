# Agentic loop harness

`agentic-loop.ps1` is a richer sibling to Ralph. Ralph runs pre-sliced `prd.json` stories; the agentic loop runs `agentic.json` tasks with workflow routing, worktrees, checks, verifier results, and harness-owned merge decisions.

## Quick start

Create or generate `agentic.json`:

```json
{
  "version": 1,
  "goal": "Fix checkout reliability",
  "maxIterations": 3,
  "checks": ["npm test"],
  "defaultDiscoveryWorkflow": "grill-with-docs",
  "tasks": [
    {
      "id": "task-001",
      "title": "Reproduce and fix retry failure",
      "status": "pending",
      "workflow": "diagnose",
      "priority": 1,
      "acceptanceCriteria": [],
      "validation": [],
      "dependsOn": [],
      "failureHistory": []
    }
  ],
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "promptPolicy": { "lessons": [] }
}
```

Run with PowerShell Core (`pwsh`):

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --checks "npm test"
pwsh -File scripts/agentic/agentic-loop.ps1 --tool pi --checks "npm test"
```

Use `pwsh -File` for harness and smoke-test commands. `powershell.exe` is only a legacy Windows PowerShell compatibility fallback for environments that do not have PowerShell Core.

For another CLI, pass a command template. `{prompt}` is replaced with the generated prompt file path:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool custom --command 'my-agent run --prompt-file {prompt}' --checks "npm test"
```

## What it does

1. Loads `agentic.json`, or creates it from `--goal` when missing.
2. If no tasks exist, runs a planner prompt that requires grill-with-docs-style discovery and writes `.agent-runs/<planner-run>/grill-transcript.md` with autonomous questions, evidence, answers, and proposals.
3. Picks the next `pending` or `needs_retry` task.
4. Creates one git worktree under `.worktrees/<task-id>` on branch `agentic/<task-id>`.
5. Runs an executor agent in that worktree.
6. Runs configured checks in that worktree, including global `--checks` / `agentic.json` checks and the selected task's `validation` commands. This is the validation discovery contract: when the planner or executor adds a focused smoke test that proves a task, it should list the command in `task.validation` (for example, `pwsh -File tests/agentic/my-focused-smoke.ps1`) so the harness runs it before verifier review.
7. Runs a verifier prompt and requires `verifier-result.json` with verdict `pass`, `fail`, or `needs_human`.
8. On pass, commits in the worktree and merges the task branch with the selected `--merge-mode` (`ff-only` by default) unless `--no-merge` or `--review-branch` is set.
9. With `--no-merge`, leaves the passed task branch/worktree in place for review; with `--review-branch`, creates `agentic/review/<safe-task-id>` and keeps the active branch unchanged. Accept either flow later with `--accept <task-id>`.
10. On check or verifier failure, records `failureHistory`. Retryable failures become `needs_retry` while the retry budget remains; use `--retry <task-id>` to rerun a specific failed task, or let normal selection pick eligible `needs_retry` tasks automatically. `--max-retries <n>` controls automatic retries after the first attempt (default from policy, or `1`).
11. Appends key harness events to `.agent-runs/events.jsonl` for audit/debug/recovery.
12. Repeats until all tasks pass or the iteration budget is exhausted.

## Safety defaults

- Starts only from a clean main worktree unless `--allow-dirty` is passed.
- `--status` is the exception to the clean-tree gate, so you can inspect `agentic.json` even while local files are dirty.
- `--doctor` is also read-only and allowed with a dirty tree; it reports stale review metadata plus missing review branches/worktrees without changing `agentic.json` or git state.
- Runs sequentially only.
- Keeps failed worktrees for inspection.
- Records task/check/verifier/review events in `.agent-runs/events.jsonl`.
- Automatically retries check/verifier failures while the task has retry budget; executor and harness failures go to `needs_human`.
- The harness, not the executor, marks task status and merges branches.
- Use `--no-merge` while testing the harness or when you want human review before integration.
- Use `--cleanup-passed` only when you are comfortable removing passed worktrees.

## Planner grill transcript

When the planner runs, it now writes a visible autonomous grill artifact:

```text
.agent-runs/<planner-run>/grill-transcript.md
```

This file records the planner's goal restatement plus the question/evidence/answer/proposal trail it used before creating `planner-result.json`. Use it to review the same kind of "grill me" reasoning you would normally do interactively, including assumptions, proposed validation, task slicing rationale, and whether human input was needed.

## Operator diagnostics and controls

Use these dirty-tree-safe diagnostics while a run is failing or slow:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --last-failure
pwsh -File scripts/agentic/agentic-loop.ps1 --why-stuck
pwsh -File scripts/agentic/agentic-loop.ps1 --summary
pwsh -File scripts/agentic/agentic-loop.ps1 --doctor
```

Use `--reset-task <task-id>` to remove a stale task worktree/branch and mark the task `needs_retry` for a clean rerun. This is mutating and should be used only when you are comfortable discarding the task branch/worktree attempt.

For low-risk tasks, `--fast-verifier` skips the separate verifier agent after checks pass and records a `verifier_skipped` event. The default remains the safer separate verifier. Use `--agent-timeout-seconds <n>` for custom/template executor/verifier commands and `--check-timeout-seconds <n>` for each validation/check command.

## Event log, recent-history prompts, and metrics

The harness writes an append-only JSONL event log at `.agent-runs/events.jsonl`. Each line records a timestamped lifecycle event such as task attempts, executor start/pass/fail, checks pass/fail, verifier verdicts, status changes, and passed review branches. `--status` prints the recent event tail.

Executor and verifier prompts include a compact recent-history tail from this event log. This gives fresh agent calls enough context to avoid repeating the latest failed attempt without stuffing entire logs into the prompt.

Validation commands can emit structured metrics with lines like:

```text
METRIC test_runtime_seconds=18.4
METRIC bundle_kb=412
```

The harness parses these lines from check output, records them in the event log, and includes a structured metric summary in `checks.log` and the verifier prompt. Metrics are observational for now; normal task pass/fail behavior still comes from checks plus verifier verdict.

## Retry flow

Failed checks or verifier `fail` results are retryable until the task exceeds its retry budget. Automatic retries use the same task branch/worktree retention rules, and the harness increments `attempts` before each run. A task with `attempts <= --max-retries` can be selected again as `needs_retry`; after the budget is exhausted, the harness records `needs_human`.

Use normal execution to let eligible `needs_retry` tasks run by priority/dependency order, or target one retryable task explicitly:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --retry task-001 --max-retries 2
```

`--retry <task-id>` requires the task to exist, have status `needs_retry` or `failed`, have passed dependencies, and still have retry budget.

## No-merge review, review branch, auto-accept, and apply flows

Use `--no-merge` when you want the harness to validate and commit a task without integrating it into the current branch:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --checks "npm test" --no-merge
pwsh -File scripts/agentic/agentic-loop.ps1 --status
```

A passing no-merge task is marked `passed` in `agentic.json` and kept on `agentic/<safe-task-id>` with its worktree under `.worktrees/<safe-task-id>`. If you prefer an explicit staging branch namespace that leaves the active branch untouched until acceptance, use `--review-branch`; passing tasks are kept on `agentic/review/<safe-task-id>` and record `reviewBranch` / `reviewWorktree` in state.

Review the diff from the main worktree, for example:

```powershell
git diff HEAD...agentic/task-001
```

After review, accept the passed task from a clean main worktree. This is the staging acceptance flow: validation and verifier pass first, a human reviews the retained branch/worktree, then `--accept <task-id>` integrates and cleans it up.

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --accept task-001
```

For unattended validation runs where no human review is needed, combine `--no-merge` with `--auto-accept-passed`. The harness still runs task validation checks and the verifier first, then immediately accepts the passed branch:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --checks "npm test" --no-merge --auto-accept-passed
```

`--accept <task-id>` verifies that the task exists and is already `passed`, integrates the corresponding `agentic/<safe-task-id>` branch, and removes the task worktree/branch after a successful integration. It uses `--merge-mode ff-only` by default. If fast-forward is not the desired operation, pass `--merge-mode cherry-pick` or `--merge-mode no-ff` explicitly:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --accept task-001 --merge-mode cherry-pick
```

For single-task review without creating an integration commit, use apply/no-commit accept mode. It applies the passed task with `git cherry-pick --no-commit`, leaves the resulting changes in the current worktree for inspection, and keeps the task branch/worktree intact for conservative cleanup:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --accept task-001 --merge-mode apply
```

If the accept merge/cherry-pick/apply fails, the branch and worktree are left intact for manual recovery.

## Focused smoke tests

```powershell
pwsh -File tests/agentic/smoke.ps1
pwsh -File tests/agentic/plan-only-smoke.ps1
pwsh -File tests/agentic/dependency-smoke.ps1
pwsh -File tests/agentic/status-dirty-smoke.ps1
pwsh -File tests/agentic/pi-adapter-smoke.ps1
pwsh -File tests/agentic/accept-smoke.ps1
pwsh -File tests/agentic/validation-checks-smoke.ps1
pwsh -File tests/agentic/validation-discovery-smoke.ps1
pwsh -File tests/agentic/auto-accept-smoke.ps1
pwsh -File tests/agentic/accept-apply-smoke.ps1
pwsh -File tests/agentic/retry-smoke.ps1
pwsh -File tests/agentic/review-branch-smoke.ps1
pwsh -File tests/agentic/doctor-smoke.ps1
pwsh -File tests/agentic/operator-diagnostics-smoke.ps1
pwsh -File tests/agentic/operator-controls-smoke.ps1
pwsh -File tests/agentic/docs-help-smoke.ps1
```
