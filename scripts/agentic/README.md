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
6. Runs configured checks in that worktree.
7. Runs a verifier prompt and requires `verifier-result.json` with verdict `pass`, `fail`, or `needs_human`.
8. On pass, commits in the worktree and merges the task branch with `git merge --ff-only` unless disabled.
9. On failure, keeps the worktree and appends `failureHistory` to the task.
10. Repeats until all tasks pass or the iteration budget is exhausted.

## Safety defaults

- Starts only from a clean main worktree unless `--allow-dirty` is passed.
- Runs sequentially only.
- Keeps failed worktrees for inspection.
- The harness, not the executor, marks task status and merges branches.
- Use `--no-merge` while testing the harness.
- Use `--cleanup-passed` only when you are comfortable removing passed worktrees.

## Smoke test

```powershell
pwsh -File tests/agentic/smoke.ps1
```
