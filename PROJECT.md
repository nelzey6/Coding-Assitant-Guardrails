# Coding Assistant Guardrails Project Map

## Purpose

This repository packages reusable agent skills, product-repo templates, and autonomous coding harnesses for Codex, Claude Code, and similar coding agents.

The main local development focus is the TypeScript agent loop under `tools/agent-loop/`. It is a typed autonomous harness that can validate this skills repository, scaffold plans, run task graphs, grill each task before execution, execute work in git worktrees, verify results, replan stale tasks, and retain operator diagnostics.

## Important Commands

Run from repository root unless noted.

```powershell
# Type-check TS agent loop
cd tools/agent-loop
npm exec -- tsc --noEmit

# Run TS harness smoke suite
cd ..\..
npx tsx tests\agentic\agent-loop-ts-smoke.ts

# Run all legacy PowerShell agentic smokes
pwsh -File tests\agentic\all-smoke.ps1

# Run TS CLI directly
cd tools/agent-loop
npm run agent -- --help
npm run agent -- validate
npm run agent -- run --help

# Start a new goal (archives existing agentic.json if present, writes fresh state)
npm run agent -- init "my goal here"

# Resume current goal (applies changes as unstaged diff when done)
npm run agent -- run --checks "cd tools/agent-loop && npx tsc --noEmit"

Local agent-session invocation note: when launching the loop from another agent, pass `--command "pi --approve --no-session -p \"@{prompt}\""` so pi trusts project-local files and each harness phase starts from a fresh session.

# Run with worktree bootstrap/env support for repos with ignored local artifacts.
# Bootstrap commands are generic shell commands: they can link deps, source an SDK,
# generate code, prepare HDL/toolchain outputs, or create any local-only fixture.
npm run agent -- run \
  --worktree-bootstrap "./scripts/bootstrap-worktree.sh" \
  --worktree-bootstrap-ignore ".toolchain-cache/**" \
  --check-env-file .env.local
```

Known environment note: local Node runs may print a warning about `NODE_EXTRA_CA_CERTS` pointing at a missing Zscaler PEM. The warning does not fail the TS typecheck or smoke suite.

## Architecture

### Main Surfaces

| Path | Role |
| --- | --- |
| `tools/agent-loop/src/index.ts` | Commander CLI entry point. Defines `validate`, `plan`, diagnostics, `accept`, `reset-task`, and `run`. |
| `tools/agent-loop/src/loop/index.ts` | Autonomous run engine. Owns planner, task-grill, executor, checks, scope rail, verifier, replan, commit/merge, handover, and finalize-docs phases. |
| `tools/agent-loop/src/prompts/index.ts` | Prompt builders for planner, task-grill, decision-grill, executor, verifier, post-task review, goal-review, architect-checkpoint, finalize-docs; plus `validatePlannerResult`/`validateDecisions` and prompt budget trimming. |
| `tools/agent-loop/src/state/index.ts` | `agentic.json` schema helpers, task selection, task status changes, attempts, failure history (including `failureAnalysisFile` pointer), planner result merge, and replan tracking (`replanCount`, `lastReplanTaskIds`). |
| `tools/agent-loop/src/agent/index.ts` | Agent invocation adapters for `claude`, `pi`, and custom command templates. |
| `tools/agent-loop/src/checks/index.ts` | Validation command execution, timeout handling, `.env` file loading for checks, structured `METRIC key=value` parsing. |
| `tools/agent-loop/src/scope/index.ts` | Scope glob matching, out-of-scope diff detection with harness-owned ignore globs, unscoped task detection, deterministic complexity escalation, fast-verifier eligibility, and high-risk task detection. |
| `tools/agent-loop/src/events/index.ts` | `.agent-runs/events.jsonl` append/load/format helpers. |
| `tools/agent-loop/src/reporting/index.ts` | Human/JSON output for status, summary, last-failure, why-stuck, doctor, reset, and accept. |
| `tools/agent-loop/src/policy/index.ts` | Loads workflow policy from `.agent-policy/workflow-policy.json` or `templates/agent-policy/workflow-policy.json`. |
| `tools/agent-loop/src/validators/index.ts` | Skills repo consistency validator for README/plugin/bucket invariants. |
| `tests/agentic/agent-loop-ts-smoke.ts` | End-to-end smoke for the TS runner using throwaway git repos and fake agents. |

### State And Artifacts

The TS loop consumes `agentic.json` in the target repo. Tasks may carry an optional `executionIntent` (`objective`, intended `steps`, current step, conditional branches, completion evidence, and update timestamp); phase prompts receive it as transparent task context. The harness does not execute it as a workflow definition. It appends lifecycle events to `.agent-runs/events.jsonl` and creates one run directory per planner/task/finalizer phase.

Important per-task artifacts:

| Artifact | Meaning |
| --- | --- |
| `task-grill.md` | Prompt that asks a fresh agent to re-understand the task before edits. |
| `task-grill-result.json` | Structured readiness verdict: `ready`, `needs_replan`, `needs_human`, or `blocked`. |
| `executor.md` | Prompt for the executor. Includes task JSON, workflow block, recent history, and task-grill result. |
| `executor.log` | Captured executor output. |
| `checks.log` | Validation command output and parsed metrics. |
| `diff.patch` / `diff-stat.txt` | Diff artifacts for verifier and handover. |
| `verifier.md` | Prompt for verifier agent. |
| `verifier-result.json` | Verifier verdict JSON. |
| `handover.md` | Executor-authored or harness-generated continuation note. |
| `state-before.json` / `state-after.json` | Snapshots around each task turn. |
| `context-capsule.md` | Canonical task/state/history evidence shared by bundled preflight and review prompts; refreshed after execution so phase-specific contracts do not repeat the full payload. |

Every completed agent invocation emits `agent_invocation_finished` with phase, tool, start/end timestamps, duration, and explicit telemetry availability. Native Pi/Claude JSON adapters additionally emit `token_usage`; plain custom commands report token telemetry as unavailable instead of silently omitting observability.

## Autonomous Run Flow

The current TS run loop is:

1. Load policy and `agentic.json`.
2. If no tasks exist, run planner. Planner must write `planner-result.json` and `grill-transcript.md`.
3. Create one shared run worktree at `.worktrees/run-<timestamp>` on branch `agentic/run-<timestamp>`; all tasks in the run commit onto this branch.
4. Pick next runnable task: `pending` or `needs_retry` with passed dependencies.
5. Run configured worktree bootstrap commands, if any, and mark configured bootstrap artifacts ignored for scope/diff/commit.
6. Run one bundled preflight invocation for task-grill readiness plus decision-grill decisions. Each logical phase keeps its separate result artifact and validation contract; legacy/custom agents that write only task-grill output fall back to a decision-only invocation.
6. If task-grill returns `ready`, inject its result and accepted decisions into executor prompt and run executor.
7. Resolve task complexity. Before high-complexity execution, run two to three clean-worktree `reflect-on-approach` stance rounds and inject the approved stance into the executor prompt.
7. If task-grill returns `needs_replan`, mark stale task `blocked`, record `task_replan_requested`, enforce replan budget, check for plan convergence, run planner again, and continue to replacement tasks.
8. If task-grill returns `needs_human` or `blocked`, stop before executor edits.
9. Run configured checks from state-level `checks`, task `validation`, and CLI `--checks`. Checks can load a configured env file. Artifact-only discovery/investigation/zoom-out tasks skip task validation unless extra CLI checks are explicitly provided.
10. Emit `scope_missing_warning` event and warn if task declares no scope (loop proceeds but diff-scope rail is inactive).
11. Enforce declared task `scope` by diffing changed files before verifier review.
12. If `--rebase-before-verify` is set, rebase worktree on loop-start HEAD and re-run checks before the verifier.
13. Run one bundled review invocation for verifier correctness plus remaining-plan review unless `--fast-verifier` is allowed. Separate result artifacts and verdict ordering remain; legacy/custom agents fall back to whichever review output is missing.
14. For high-risk tasks, run adversarial verifier votes unless overridden.
15. On pass, commit to the shared run branch (not to main).
16. Write handover/progress artifacts.
17. Run post-task plan review by default. This fresh review asks whether the remaining plan is still correctly sliced, scoped, ordered, and validated after the completed task. Verdicts: `continue`, `adjust_remaining_tasks`, `replan`, `needs_human`.
18. On post-task review `adjust_remaining_tasks`, record the advice as an advisory event and continue to the next runnable task; task-grill remains the just-in-time gate for deciding whether that specific task needs replan. On post-task review `replan`, block stale pending/retry tasks, enforce the replan budget/convergence guard, run planner again, and continue to replacement tasks.
19. Every three passed tasks by default, run architect checkpoint over cumulative diff and remaining plan; `replan` calls planner, `needs_human` halts.
20. When no runnable tasks remain, treat `passed` and `blocked` as terminal statuses. If all unfinished work is terminal, apply run branch to main tree as unstaged changes (default) or merge (`--merge`), clean up run worktree, and complete.

Planner slicing rule: tasks represent independent verification slices. Split only for distinct risk, proof, ownership/scope, rollback value, or dependency; do not create one task per helper/file move when validation is shared.

## Task-Grill Contract

Task-grill is the key critical-thinking gate. It exists because a single up-front plan goes stale on larger goals.

Each task turn asks a fresh agent to inspect current repo state and recent loop history before editing. The result schema is:

```json
{
  "verdict": "ready|needs_replan|needs_human|blocked",
  "understanding": "...",
  "evidence": ["path or command inspected"],
  "assumptionsStillValid": [],
  "assumptionsChanged": [],
  "scopeDecision": {
    "declaredScopeOk": true,
    "requestedScopeChanges": []
  },
  "acceptanceProof": ["command or artifact expected"],
  "risks": [],
  "executorInstructions": "Concrete instructions for the executor on this turn."
}
```

Verdict behavior:

| Verdict | Harness behavior |
| --- | --- |
| `ready` | Continue to executor. |
| `needs_replan` | Mark current task `blocked`, call planner again, continue loop. |
| `needs_human` | Mark task `needs_human`, stop before edits. |
| `blocked` | Mark task `blocked`, stop before edits. |

## Safety Rails

Current TS rails:

- All tasks share one run worktree/branch (`agentic/run-<timestamp>`); tasks chain via commits on that branch.
- Worktree bootstrap commands can prepare ignored local dependencies, generated code, HDL/toolchain outputs, SDK/env links, or other local-only artifacts before task-grill/checks; bootstrap-owned paths are excluded from diff artifacts, scope rail, and commits. This mechanism is target-repo generic and is not specific to Node projects.
- `run` refuses to start implicitly when `agentic.json` contains a task still marked `running`; it prints the last event/run directory and asks the operator to choose `reset-task <id> --apply`, `run --continue`, or `run --new-run` explicitly. This prevents accidental new run branches when the operator expected to resume an interrupted loop.
- `run` enforces the policy clean-main-worktree gate when `autonomousLoop.requireCleanMainWorktree` is true. Use `--allow-dirty` only when intentionally running with uncommitted main-worktree changes.
- Harness owns task status, verifier result handling, commit, merge, and cleanup.
- Task-grill must pass before executor runs.
- Task-grill and decision-grill share one preflight invocation when the agent supports the bundled contract. Their verdict ordering and legacy artifacts remain independent.
- Verifier and post-task review share one bundled review invocation when supported. Verification is processed first; plan advice is ignored on verification failure, preserving executor/reviewer independence and retry semantics.
- Bundled phases reference one `context-capsule.md` per task turn. Contract-only decision and plan-review sections reuse that evidence instead of embedding a second copy of task JSON, assumptions, decisions, and event history.
- Tasks with no declared `scope` emit `scope_missing_warning`; the diff-scope rail is inactive for them.
- Scope rail blocks changed files outside declared task scope.
- Fast verifier is denied unless task kind is low-risk and scope is declared.
- High-risk tasks can receive multiple adversarial verifier votes.
- Check/verifier failures retry until budget, then escalate to `needs_human`.
- Artifact-only discovery/investigation/zoom-out tasks are allowed to prove completion through artifacts/evidence instead of implementation validation commands.
- On every failure (checks, scope, verifier, rebase-checks), the harness writes `failure-analysis.json` to the run dir with phase, attempt, truncated reason, and diff stat. The path is stored in the task's `failureHistory` and injected into the next task-grill and replan planner prompts to break blind-retry loops.
- Runtime and agent-call budgets emit `budget_exhausted`.
- Replan budget (`--max-replans`, default 5) caps how many times task-grill can trigger replanning per session; exhaustion emits `replan_budget_exhausted` and escalates to `needs_human`.
- Convergence detection: if a replan produces the same task IDs as the previous replan, the loop emits `replan_convergence_failure` and halts.
- `--rebase-before-verify`: optional gate that rebases the worktree on loop-start HEAD and re-runs checks before the verifier, catching post-merge integration failures early.
- After each `ready` task-grill verdict, `assumptionsStillValid` and `assumptionsChanged` fields from the result are persisted back into `state.assumptions` (tagged `[valid]`/`[changed]`) and emitted as an `assumptions_updated` event. The current assumption list is forwarded into every subsequent task-grill prompt so drift is visible across turns.
- `--goal-review` (opt-in): after all tasks pass, a goal-review agent judges the cumulative diff against `state.goal` and emits `goal_review_finished`. A `needs_human` verdict halts the loop before finalize-docs.
- Post-task plan review is default-on after every passed task. It reviews assumption drift, remaining task slicing/scope/order, and validation design. `adjust_remaining_tasks` records advisory feedback and continues so task-grill can make the next just-in-time replan decision; `replan` blocks stale pending/retry tasks before planner appends replacements; `needs_human` halts.
- `--architect-checkpoint-interval <n>` (default 0): optional legacy cumulative checkpoint. It is disabled by default because post-task plan reflection owns remaining-plan drift.
- High-complexity tasks run iterative `reflect-on-approach` stance review before executor edits. The harness rejects stance agents that dirty the worktree and records the approved stance as a run artifact.
- `--decision-grill` (opt-in): before each executor turn, a grill-with-docs self-interview surfaces genuine design/product decisions and answers them itself with evidence. The harness enforces a decision contract via `validateDecisions` (each decision needs 2-4 evidenced options, exactly one marked recommended, plus `whyItMatters`/`selfAnswer`/`confidence`/`escalate`). Shallow or low-confidence-without-escalate results trigger exactly one re-grill (`decision_grill_regrill`); if still inadequate, or any decision sets `escalate:true`/stays low-confidence, the task escalates to `needs_human`. Answered decisions are flattened into `state.decisions` and emitted as `decisions_recorded`. The planner result's `decisions` are validated by the same contract and normalized to strings on merge.
- `accept` and `reset-task` are dry-run by default and require `--apply` to mutate.

Known gaps before calling the TS runner production-default:

- CLI defaults do not fully honor policy defaults such as retry count and merge mode.
- `promptPolicy.lessons` exists in state but is not yet updated as structured learning memory.

## Validation Coverage

`tests/agentic/agent-loop-ts-smoke.ts` currently covers:

- happy path task execution and verifier pass
- task-grill result injection into executor prompt
- task-grill `needs_human` stop before executor edits
- task-grill `needs_replan` planner loop and replacement task execution
- unscoped task emits `scope_missing_warning` but still completes
- scope violation blocking
- scope clean pass
- fast-verifier denied for high-risk task
- fast-verifier allowed for low-risk scoped task
- check failure retry then pass
- verifier failure retry budget exhaustion to `needs_human`
- failure-analysis injected into task-grill prompt on retry
- replan budget exhaustion (`replan_budget_exhausted`) via `--max-replans`
- replan convergence detection (`replan_convergence_failure`) when plan produces identical task IDs
- assumption ledger: task-grill `assumptionsStillValid`/`assumptionsChanged` persisted to `state.assumptions` with `[valid]`/`[changed]` tags and emitted as `assumptions_updated` event
- goal review: `--goal-review` pass verdict allows completion, `needs_human` halts before finalize-docs
- post-task review: default `continue` verdict runs after passed tasks
- post-task review: `replan` verdict blocks stale remaining tasks, calls planner, and continues with replacement task
- post-task review: `adjust_remaining_tasks` records an advisory event and continues to the next runnable task without calling planner
- post-task review: `needs_human` verdict halts loop before any dependent task runs
- architect checkpoint: `continue` verdict proceeds, `replan` verdict calls planner and continues with new task
- architect checkpoint: `needs_human` verdict halts loop without running further tasks
- planner from empty task list: plans then executes planned task
- decision grill: well-formed self-answered decision recorded to `state.decisions` and task passes
- decision grill: shallow decision (1 option) re-grilled once, then escalates to `needs_human` before executor edits
- decision grill: low-confidence decision re-grilled once, answered with high confidence on the second pass
- agent-call budget exhaustion (`budget_exhausted`) via `--max-agent-calls`
- worktree bootstrap artifact ignores do not trigger scope violations
- `--check-env-file` loads environment variables for validation commands
- artifact-only `zoom-out` tasks skip task validation commands and rely on artifact/verifier proof
- `validate` fails on zero discovered skills unless `--allow-empty` is passed
- `run` blocks dirty main worktrees by default and proceeds with `--allow-dirty`

Missing TS smoke coverage:

- real `claude` / `pi` commands beyond the default adapter path
- `--rebase-before-verify` gate (requires real multi-commit git scenario)
- CodeGraph context invocation (requires `codegraph` on PATH)
- finalize-docs behavior
- accept/apply/review-branch flows
- doctor/reset commands
- runtime budget exhaustion (`--max-runtime-seconds`)
- policy default adoption
- clean-tree gate

## Documentation Truth

Root ADRs live in `adrs/`. `docs/adr/` contains older ADRs and should not receive new decisions.

`scripts/agentic/setup-agentic.ps1` and `setup-agentic.sh` now install the TS runner (`tools/agent-loop/src/index.ts`) as the `agentic-loop` shim. They require Node.js >= 20 and `npm install` inside `tools/agent-loop/` to have been run. The shims bake the absolute path to `node`, `tsx/dist/cli.mjs`, and `src/index.ts` at install time. `scripts/agentic/agentic-loop.ps1` remains as the legacy PowerShell harness reference but is no longer installed by the setup scripts.

## Repository Constraints

- Skills in `engineering/`, `productivity/`, and `misc/` must be linked from top-level `README.md`, bucket `README.md`, and `.claude-plugin/plugin.json`.
- Skills in `personal/`, `in-progress/`, and `deprecated/` must not be exposed in those surfaces.
- Do not modify upstream-derived skills from `mattpocock/skills`; put local behavior in local files/skills/templates.
- Do not commit `.agent-runs/`, `.worktrees/`, `.codegraph/`, or local runtime state.
