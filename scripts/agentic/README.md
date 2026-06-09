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

Run:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --checks "npm test"
pwsh -File scripts/agentic/agentic-loop.ps1 --tool pi --checks "npm test"
```

For another CLI, pass a command template. `{prompt}` is replaced with the generated prompt file path:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool custom --command 'my-agent run --prompt-file {prompt}' --checks "npm test"
```

## What it does

1. Loads `agentic.json`, or creates it from `--goal` when missing.
2. If no tasks exist, runs a planner prompt that requires grill-with-docs-style discovery.
3. Picks the next `pending` or `needs_retry` task.
4. Creates one git worktree under `.worktrees/<task-id>` on branch `agentic/<task-id>`.
5. Runs an executor agent in that worktree.
6. Runs configured checks in that worktree, including global `--checks` / `agentic.json` checks and the selected task's `validation` commands. When a task adds a focused smoke test that proves the change, put it in `task.validation` (for example, `pwsh -File tests/agentic/my-focused-smoke.ps1`) so the harness runs it before verifier review.
7. Runs a verifier prompt and requires `verifier-result.json` with verdict `pass`, `fail`, or `needs_human`.
8. On pass, commits in the worktree and merges the task branch with the selected `--merge-mode` (`ff-only` by default) unless `--no-merge` is set.
9. With `--no-merge`, leaves the passed task branch/worktree in place for review; accept it later with `--accept <task-id>`.
10. On failure, keeps the worktree and appends `failureHistory` to the task.
11. Repeats until all tasks pass or the iteration budget is exhausted.

## Safety defaults

- Starts only from a clean main worktree unless `--allow-dirty` is passed.
- `--status` is the exception to the clean-tree gate, so you can inspect `agentic.json` even while local files are dirty.
- Runs sequentially only.
- Keeps failed worktrees for inspection.
- The harness, not the executor, marks task status and merges branches.
- Use `--no-merge` while testing the harness or when you want human review before integration.
- Use `--cleanup-passed` only when you are comfortable removing passed worktrees.

## No-merge review, auto-accept, and apply flows

Use `--no-merge` when you want the harness to validate and commit a task without integrating it into the current branch:

```powershell
pwsh -File scripts/agentic/agentic-loop.ps1 --tool claude --checks "npm test" --no-merge
pwsh -File scripts/agentic/agentic-loop.ps1 --status
```

A passing no-merge task is marked `passed` in `agentic.json` and kept on `agentic/<safe-task-id>` with its worktree under `.worktrees/<safe-task-id>`. Review the diff from the main worktree, for example:

```powershell
git diff HEAD...agentic/task-001
```

After review, accept the passed task from a clean main worktree:

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
```
