# Agentic loop — full reference

This document covers everything beyond the quick start: all flags, review flows, retry behavior, safety rails, diagnostics, and smoke tests.

For the visual phase diagram see [agentic-loop-flow.md](./agentic-loop-flow.md).  
For the quick start see [scripts/agentic/README.md](../scripts/agentic/README.md).

---

## How it works

1. Loads `agentic.json`, or selects planner-lite/full planning when no tasks exist yet. Auto mode uses planner-lite only for conservative, explicitly scoped documentation/maintenance goals.
2. Full planning runs grill-with-docs-style discovery; planner-lite writes the same `.agent-runs/<planner-run>/grill-transcript.md` artifact with a concise evidence and fallback record.
3. Creates one shared git worktree under `.worktrees/run-<timestamp>` on branch `agentic/run-<timestamp>` — all tasks in the run commit onto this branch.
4. Picks the next `pending` or `needs_retry` task (by priority, then dependency order).
5. Admits each phase from current evidence. Fresh planner tasks inherit planner readiness; stale/manual tasks run a **task-grill** agent, and decision-grill is bundled only on that slower path.
6. Resolves design forks with evidenced options when decision-grill is admitted; accepted decisions become binding rules in the executor prompt.
7. A task-grill `ready` verdict with changed assumptions blocks the stale task and replans before executor execution.
8. Runs an **executor** agent in the shared run worktree under parent-checkout isolation.
9. Runs configured **checks** (global `--checks` + task `validation` commands).
10. Resolves one final verification decision from complexity, meaningful scope bounds, actual changed paths, failures, architecture intent, semantic/path human gates, policy, and operator overrides. Bounded docs can use checks; normal changes use one verifier; high-risk changes use adversarial votes.
11. Runs a **post-task plan review** only when verifier, complexity, or scope evidence indicates remaining-plan drift; deterministic skips remain in the event log.
12. Optionally runs a legacy **architect checkpoint** when `--architect-checkpoint-interval` is configured; it defaults off.
13. On failure: records `failureHistory`, marks `needs_retry` or `needs_human` based on retry budget.
14. Repeats until all tasks pass or the iteration budget is exhausted.
15. On completion: applies run branch to main tree as **unstaged changes** (default) or merges if `--merge` is set.

---

## All flags

```
--command <template>         Custom default agent command; {prompt} = prompt file path. Auto-detects claude/pi if omitted.
--planner-command <tpl>      Planner/replan/checkpoint command (defaults to --command or auto-detected)
--planner-mode <mode>        auto | lite | full (overrides repository policy; fallback: policy then auto)
--grill-command <tpl>        Task-grill/decision-grill/post-task review command (defaults to --command or auto-detected)
--executor-command <tpl>     Executor command (defaults to --command or auto-detected)
--verifier-command <tpl>     Separate verifier command (defaults to --command or auto-detected)
--checks <cmd>               Extra check command, repeatable; merged with task.validation
--worktree-bootstrap <cmd>   Bootstrap command run inside each task worktree before agents/checks
--worktree-bootstrap-ignore <path>  Bootstrap artifact path ignored by scope/diff/commit
--check-env-file <path>      Env file loaded for validation checks, relative to worktree or absolute
--state <path>               State file (default: agentic.json)
--worktree-root <path>       Worktree root (default: .worktrees)
--runs-root <path>           Run artifact root (default: .agent-runs)
--max-iterations <n>         Max task loop iterations (default: 10)
--max-retries <n>            Max automatic retries per task (default: 1)
--max-runtime-seconds <n>    Hard wall-clock cap for the whole run (0 = off)
--max-agent-calls <n>        Hard cap on total planner+executor+verifier calls (0 = off)
--max-replans <n>            Max replans before escalating to needs_human (default: 5)
--verifier-votes <n>         Verifier vote count override (0 = auto: 3 for high-risk, 1 otherwise)
--agent-timeout <n>          Timeout for each agent invocation
--check-timeout <n>          Timeout for each check command
--prompt-budget low|medium|high  How much context to inline in prompts (default: medium)
--merge-mode ff-only|no-ff|cherry-pick  Merge strategy when --merge is set (default: ff-only)
--no-commit                  Don't commit changes after a pass
--no-apply                   Don't apply run branch to main tree at the end; keep the run branch intact
--merge                      Merge run branch into main instead of applying as unstaged changes
--review-branch              Use agentic/review/<id> namespace and don't touch active branch
--cleanup-passed             Remove worktree after a task passes
--plan-only                  Run planner only, write agentic.json, then stop
--retry <task-id>            Force-retry a specific needs_retry/failed task
--fast-verifier              Request the verifier fast path (still denied for non-low-risk tasks)
--rebase-before-verify       Rebase worktree on loop-start HEAD before verifier; re-runs checks
--allow-dirty                Allow starting run with uncommitted changes in main worktree
--goal-review                Run goal-review agent after all tasks pass
--no-post-task-review        Disable plan review even when drift evidence would admit it
--architect-checkpoint-interval <n>  Run legacy architect checkpoint every N passed tasks (0 = off, default: 0)
--no-decision-grill          Skip the per-task design decision self-interview
--no-finalize-docs           Disable finalize-docs even when documentation changed
```

`validate` also supports `--allow-empty` for intentionally empty skill repos. Without it, validating a repo with zero discovered skills exits non-zero to catch wrong working-directory usage.

Worktree bootstrap is intentionally language/toolchain-neutral. Use it for Node deps, Python venv links, CMake build dirs, embedded SDK setup, FPGA vendor tool outputs, generated HDL artifacts, or any other local-only preparation. Put those local-only paths in `--worktree-bootstrap-ignore` so they do not appear in scope/diff/commit checks.

---

## Review flows

### Default — apply as unstaged changes

When the run completes, the harness applies the run branch to your main working tree as **unstaged changes** and cleans up the run worktree. You see the full diff, stage what you want, and commit when you're ready.

```bash
agentic-loop run --checks "npm test"
# ... loop runs ...
git status        # see all changed files
git diff          # review the full diff
git add -p        # stage selectively
git commit        # your commit, your message
```

### `--merge` — auto-merge on completion

Merges the run branch into your active branch immediately after all tasks pass. Nothing staged in your working tree.

```bash
agentic-loop run --merge --checks "npm test"
```

### `--no-apply` — keep the run branch intact

Skips both apply and merge. The run branch (`agentic/run-<timestamp>`) stays around for manual inspection.

```bash
agentic-loop run --no-apply --checks "npm test"
# inspect later
git diff HEAD...agentic/run-20260619-102207
```

### `--review-branch` — separate staging namespace

Uses `agentic/review/<id>` branches. Active branch is never touched until you accept.

```powershell
agentic-loop run --review-branch --checks "npm test"
agentic-loop accept task-001
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

**Adaptive verification admission** — task kind, complexity, and verification risk are independent. After checks, one final decision drives both execution and `verification_profile_resolved`. Catch-all scopes are broad; semantic policy gates and path gates are high risk. Normal code uses one verifier; high-risk work uses three refute-first votes by default.

**Fast-verifier guard** — meaningfully bounded low-complexity documentation-only actual diffs can skip the separate verifier after checks, including `implementation` tasks. `**`, root wildcard scopes, normal code, and high-risk changes cannot. Policy-forced verification and `--verifier-votes` are normalized before telemetry, so traced votes match executed votes.

**Parent-checkout isolation** — executor calls are guarded by content fingerprints covering tracked diffs and non-ignored untracked files. Comparison runs after success and failure, detects changes to already-dirty files, stops before checks/integration, and never restores user content automatically.

**Phase admission** — defaults are `taskGrill: plan-aware`, `verifier: auto`, `postTaskReview: on-drift`, `finalizeDocs: on-change`, and `retryTaskGrill: on-drift`. The harness emits `phase_admitted` or `phase_skipped` for each gated phase. Planner ambiguity emits `goal_intake_needs_human`; check failures retry directly, while non-check failures re-grill before retry.

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

Use the smallest smoke matching the changed seam. Filter the TypeScript suite
by case name when possible; do not run every smoke as the default response to a
small change.

```bash
AGENTIC_SMOKE_FILTER="planner from empty state" \
  ./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/phase-admission-smoke.ts
```

Run the complete suites only for shared state/CLI contracts, broad
orchestration/process changes, unknown impact, release-critical changes, or
focused-check failures that need wider diagnosis. Record the reason and any
incomplete coverage. Broad suite command:

```powershell
pwsh -File tests/agentic/all-smoke.ps1   # exceptional broad validation

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
