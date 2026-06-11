# Agentic loop — full reference

This document covers everything beyond the quick start: all flags, review flows, retry behavior, safety rails, diagnostics, and smoke tests.

For the visual phase diagram see [agentic-loop-flow.md](./agentic-loop-flow.md).  
For the quick start see [scripts/agentic/README.md](../scripts/agentic/README.md).

---

## How it works

1. Loads `agentic.json`, or creates it via a planner agent when `--goal` is given and no tasks exist yet.
2. Runs grill-with-docs-style discovery during planning and writes `.agent-runs/<planner-run>/grill-transcript.md` with the question/evidence/answer/proposal trail.
3. Picks the next `pending` or `needs_retry` task (by priority, then dependency order).
4. Creates one git worktree under `.worktrees/<task-id>` on branch `agentic/<task-id>`.
5. Runs a **task-grill** agent to confirm the task is still understood and safe before any edits.
6. Runs an **executor** agent in the worktree.
7. Runs configured **checks** (global `--checks` + task `validation` commands).
8. Runs a **verifier** agent; requires `verifier-result.json` with verdict `pass`, `fail`, or `needs_human`.
9. On pass: commits + merges (unless `--no-merge` / `--review-branch`).
10. Runs a **post-task plan review** after every passed task to decide whether the remaining plan is still valid.
11. Runs an **architect checkpoint** every three passed tasks by default; the checkpoint may force replanning.
12. On failure: records `failureHistory`, marks `needs_retry` or `needs_human` based on retry budget.
13. Repeats until all tasks pass or the iteration budget is exhausted.

---

## All flags

```
--goal <text>                Goal text; used to create agentic.json when missing
--tool <name>                pi | claude | custom  (default: pi)
--command <template>         Custom executor command; {prompt} = prompt file path
--verifier-command <tpl>     Separate verifier command (defaults to --command)
--checks <cmd>               Extra check command, repeatable; merged with task.validation
--state <path>               State file (default: agentic.json)
--policy <path>              Workflow policy file
--worktree-root <path>       Worktree root (default: .worktrees)
--runs-root <path>           Run artifact root (default: .agent-runs)
--max-iterations <n>         Max task loop iterations (default: 10)
--max-retries <n>            Max automatic retries per task (default: 1)
--max-runtime-seconds <n>    Hard wall-clock cap for the whole run (0 = off)
--max-agent-calls <n>        Hard cap on total planner+executor+verifier calls (0 = off)
--max-replans <n>            Max replans before escalating to needs_human (default: 5)
--verifier-votes <n>         Verifier vote count override (0 = auto: 3 for high-risk, 1 otherwise)
--agent-timeout-seconds <n>  Timeout for each agent invocation (custom commands only)
--check-timeout-seconds <n>  Timeout for each check command
--prompt-budget low|normal|high  How much context to inline in prompts (default: normal)
--merge-mode ff-only|no-ff|cherry-pick  Merge strategy (default: ff-only)
--no-commit                  Don't commit changes after a pass
--no-merge                   Don't merge after a pass; keep branch for review
--review-branch              Use agentic/review/<id> namespace and don't touch active branch
--auto-accept-passed         Immediately accept + clean up after verifier pass (with --no-merge)
--cleanup-passed             Remove worktree after a task passes
--plan-only                  Run planner only, write agentic.json, then stop
--retry <task-id>            Force-retry a specific needs_retry/failed task
--fast-verifier              Skip verifier agent for low-risk tasks that pass checks
--rebase-before-verify       Rebase worktree on loop-start HEAD before verifier; re-runs checks
--goal-review                Run goal-review agent after all tasks pass
--no-post-task-review        Skip the default plan-validity review after each passed task
--architect-checkpoint-interval <n>  Run architect checkpoint every N passed tasks (0 = off, default: 3)
--no-decision-grill          Skip the per-task design decision self-interview
--no-finalize-docs           Skip final PROJECT.md refresh after all tasks pass
--allow-dirty                Allow starting with uncommitted changes in main worktree
--status                     Print state summary and exit (dirty-tree safe)
--summary                    Print compact checkpoint summary and exit (dirty-tree safe)
--last-failure               Print most recent failure context and exit (dirty-tree safe)
--why-stuck                  Explain blocked/needs_human tasks (dirty-tree safe)
--doctor                     Diagnose stale review metadata without mutating state
--reset-task <task-id>       Remove worktree/branch and mark needs_retry for a clean rerun
--accept <task-id>           Integrate a passed no-merge task and clean up
```

---

## Review flows

### Default — auto-merge on pass

Tasks merge into the active branch immediately after verifier pass. Nothing to do after the run.

### `--no-merge` — human reviews before integration

```powershell
agentic-loop run --no-merge --checks "npm test"
# inspect the diff
git diff HEAD...agentic/task-001
# accept when satisfied
agentic-loop accept task-001
```

### `--review-branch` — separate staging namespace

Uses `agentic/review/<id>` branches. Active branch is never touched until you accept.

```powershell
agentic-loop run --review-branch --checks "npm test"
agentic-loop accept task-001
```

### `--auto-accept-passed` — unattended validation without human review

Validates and merges immediately. Skips the human review step.

```powershell
agentic-loop run --no-merge --auto-accept-passed --checks "npm test"
```

### `--merge-mode apply` — inspect without committing

Applies the task with `git cherry-pick --no-commit`. Changes land staged in your worktree; branch is kept intact.

```powershell
agentic-loop accept task-001 --merge-mode apply
```

---

## Retry flow

Failed checks or verifier `fail` → task marked `needs_retry` while within `--max-retries` budget, then `needs_human`.

Executor and harness errors always go straight to `needs_human`.

To retry a specific task manually:

```powershell
agentic-loop run --retry task-001 --max-retries 2
```

To clean up a stuck task and restart it fresh:

```powershell
agentic-loop reset-task task-001 --apply
agentic-loop run
```

---

## Safety rails

**Clean-tree gate** — refuses to start with uncommitted changes unless `--allow-dirty`. Diagnostics (`--status`, `--doctor`, `--why-stuck`, etc.) are always allowed dirty.

**Diff-scope rail** — if a task declares `scope` globs, the harness checks `git diff --name-only HEAD` after execution; files outside scope cause a retryable `scope_violation`.

**Planner complexity budget** — rejects tasks with >7 acceptance criteria, >5 scope globs, or empty criteria on implementation tasks.

**Circuit breakers** — `--max-runtime-seconds` and `--max-agent-calls` stop the loop cleanly with a `budget_exhausted` event and `needs_human` handoff.

**Adversarial verifier** — high-risk tasks (implementation/architecture kind with scope, or scope matching a human-gate path) get `--verifier-votes` independent refute-first votes; majority pass required.

**Fast-verifier guard** — `--fast-verifier` is only honored for low-risk tasks (`maintenance`/`discovery`/`investigation` kind with a declared scope). High-risk tasks force the full verifier and log `verifier_skip_denied`.

---

## Event log and metrics

All events append to `.agent-runs/events.jsonl`. Each line is a timestamped JSON record: task attempts, executor/checks/verifier outcomes, status changes, review branches.

Validation commands can emit structured metrics:

```text
METRIC test_runtime_seconds=18.4
METRIC bundle_kb=412
```

The harness parses these, records them in the event log, and includes them in the verifier prompt. Pass/fail behavior still comes from exit codes and verifier verdict — metrics are observational.

---

## Smoke tests

```powershell
pwsh -File tests/agentic/all-smoke.ps1   # run all at once

# individually:
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
pwsh -File tests/agentic/finalize-docs-smoke.ps1
pwsh -File tests/agentic/codegraph-context-smoke.ps1
pwsh -File tests/agentic/scope-rail-smoke.ps1
pwsh -File tests/agentic/planner-budget-smoke.ps1
pwsh -File tests/agentic/fast-verifier-guard-smoke.ps1
pwsh -File tests/agentic/circuit-breaker-smoke.ps1
pwsh -File tests/agentic/shell-hardening-smoke.ps1
pwsh -File tests/agentic/adversarial-verifier-smoke.ps1
pwsh -File tests/agentic/docs-help-smoke.ps1
```
