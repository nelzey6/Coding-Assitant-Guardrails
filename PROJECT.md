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

# Run the focused phase-admission smoke
cd ..\..
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/phase-admission-smoke.ts

# Run one applicable TS end-to-end smoke (filter by case name)
AGENTIC_SMOKE_FILTER="planner from empty state" ./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts

# Full TS smoke suite — exceptional, not default verification
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts

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

## Verification Strategy

Use [verification-policy.md](docs/verification-policy.md) for validation
selection. Start from changed files, acceptance criteria, owning module, and
affected callers. Run the smallest deterministic proof first:

- docs/policy-only change → diff check, JSON/link validation, or relevant validator;
- helper/admission change → focused smoke plus typecheck;
- one loop phase → filtered end-to-end smoke plus typecheck;
- CLI/transport/worktree change → filtered end-to-end smoke plus targeted integration check;
- cross-module/public contract change → broaden only with explicit impact evidence.

Do not automatically run `all-smoke.ps1` or the complete TypeScript smoke suite
for a small change. Full suites are reserved for shared contracts, broad
orchestration/process changes, unknown impact, release-critical changes, or a
focused-check failure that needs wider diagnosis. Record the reason and any
incomplete coverage in the handoff.

## Architecture

### Main Surfaces

| Path | Role |
| --- | --- |
| `tools/agent-loop/src/index.ts` | Commander CLI entry point. Defines `validate`, `plan`, diagnostics, `accept`, `reset-task`, and `run`. |
| `tools/agent-loop/src/loop/index.ts` | Autonomous run engine. Owns planner, task-grill, executor, checks, scope rail, verifier, replan, commit/merge, handover, and finalize-docs phases. |
| `tools/agent-loop/src/prompts/index.ts` | Prompt builders for planner/planner-lite, task-grill, decision-grill, executor, verifier, post-task review, goal-review, architect-checkpoint, finalize-docs; plus `validatePlannerResult`/`validateDecisions` and prompt budget trimming. |
| `tools/agent-loop/src/state/index.ts` | `agentic.json` schema helpers, task selection, task status changes, attempts, failure history (including `failureAnalysisFile` pointer), planner result merge, and replan tracking (`replanCount`, `lastReplanTaskIds`). |
| `tools/agent-loop/src/agent/index.ts` | Agent invocation adapters for `claude`, `pi`, and custom command templates. |
| `tools/agent-loop/src/checks/index.ts` | Validation command execution, timeout handling, `.env` file loading for checks, structured `METRIC key=value` parsing. |
| `tools/agent-loop/src/scope/index.ts` | Scope glob matching, meaningful-bounds detection, out-of-scope diff detection, documentation/path facts, and deterministic complexity escalation. |
| `tools/agent-loop/src/admission/index.ts` | Final phase-admission decisions, including adaptive verification risk/mode/votes from task, diff, scope, policy human gates, and operator overrides. |
| `tools/agent-loop/src/events/index.ts` | `.agent-runs/events.jsonl` append/load/format helpers. |
| `tools/agent-loop/src/reporting/index.ts` | Human/JSON output for status, summary, last-failure, why-stuck, doctor, reset, and accept. |
| `tools/agent-loop/src/policy/index.ts` | Loads workflow policy, resolves planner-mode precedence, and matches semantic human-gate declarations against task evidence. |
| `tools/agent-loop/src/tools/index.ts` | Git/worktree operations and content-based parent-checkout isolation guards. |
| `docs/verification-policy.md` | Validation selection policy: focused proof first, explicit evidence before broad suites. |
| `tools/agent-loop/src/validators/index.ts` | Skills repo consistency validator for README/plugin/bucket invariants. |
| `tests/agentic/agent-loop-ts-smoke.ts` | End-to-end smoke for the TS runner using throwaway git repos and fake agents. |

### State And Artifacts

The TS loop consumes `agentic.json` in the target repo. It appends lifecycle events to `.agent-runs/events.jsonl` and creates one run directory per planner/task/finalizer phase.

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

Every completed agent invocation emits `agent_invocation_finished` with phase, tool, start/end timestamps, duration, assistant-turn count, tool-call count, log bytes, and explicit telemetry availability. Native Pi/Claude JSON adapters additionally emit `token_usage`; plain custom commands report token telemetry as unavailable instead of silently omitting observability.

## Autonomous Run Flow

The current TS run loop is:

1. Load policy and `agentic.json`.
2. If no tasks exist, select planner mode. Conservative low-risk documentation/maintenance goals use planner-lite; ambiguous, risky, failed, or subsequent planning revisions use the full planner. Both modes write `planner-result.json` and `grill-transcript.md`.
3. Create one shared run worktree at `.worktrees/run-<timestamp>` on branch `agentic/run-<timestamp>`; all tasks in the run commit onto this branch.
4. Pick next runnable task: `pending` or `needs_retry` with passed dependencies.
5. Run configured worktree bootstrap commands, if any, and mark configured bootstrap artifacts ignored for scope/diff/commit.
6. Admit task-grill from the planner revision: fresh planned tasks with no open questions or blockers inherit planner readiness and write a synthetic result; stale/manual tasks and non-check retries run the bundled task-grill/decision-grill preflight. Every admission or skip is recorded as `phase_admitted`/`phase_skipped`.
7. If task-grill returns `ready` with changed assumptions, persist the evidence, block the stale task, and replan before any executor starts. Otherwise inject its result and accepted decisions into the executor prompt and run in the isolated worktree. The prompt names the active worktree and forbids parent-repository absolute paths; a content snapshot also stops tracked, already-dirty, or untracked parent-checkout mutation on executor success or failure.
8. Resolve task complexity. Before high-complexity execution, run two to three clean-worktree `reflect-on-approach` stance rounds and inject the approved stance into the executor prompt.
9. If task-grill returns `needs_replan`, mark stale task `blocked`, record `task_replan_requested`, enforce replan budget, check for plan convergence, run planner again, and continue to replacement tasks.
10. If task-grill returns `needs_human` or `blocked`, stop before executor edits. A planner `needs_human`/`blocked` verdict likewise emits `goal_intake_needs_human` and stops before execution.
11. Run configured checks from state-level `checks`, task `validation`, and CLI `--checks`. Checks can load a configured env file. Artifact-only discovery/investigation/zoom-out tasks skip task validation unless extra CLI checks are explicitly provided.
12. Emit `scope_missing_warning` event and warn if task declares no scope (loop proceeds but diff-scope rail is inactive).
13. Enforce declared task `scope` by diffing changed files before verifier review.
14. If `--rebase-before-verify` is set, rebase worktree on loop-start HEAD and re-run checks before the verifier.
15. Resolve one final verification admission after checks and scope enforcement. Meaningfully bounded low-complexity documentation-only diffs skip the separate verifier regardless of task kind; normal changes receive one verifier; architecture, high-complexity, catch-all/broad, path-gate, or semantic policy-gate changes receive adversarial votes. Explicit `--fast-verifier`, `verifier: always`, and vote overrides are normalized into this same traced decision.
16. Bundle verifier with post-task review only when deterministic drift evidence already requires review; otherwise the verifier is a single-purpose invocation. Verifier issues can still trigger a standalone review after a pass.
17. On pass, commit to the shared run branch (not to main).
18. Write handover/progress artifacts.
19. Run post-task plan review only when verifier issues exist, complexity/scope overlap makes drift plausible, or policy requires it. Changed assumptions already forced a pre-executor replan. Verdicts: `continue`, `adjust_remaining_tasks`, `replan`, `needs_human`.
20. On post-task review `adjust_remaining_tasks`, record the advice as an advisory event and continue to the next runnable task. On `replan`, block stale pending/retry tasks, enforce the replan budget/convergence guard, run planner again, and continue to replacement tasks.
21. Every three passed tasks by default, run architect checkpoint over cumulative diff and remaining plan; `replan` calls planner, `needs_human` halts.
22. When no runnable tasks remain, run finalize-docs only if durable documentation changed (unless policy or operator enables it unconditionally), then treat `passed` and `blocked` as terminal statuses. If all unfinished work is terminal, apply run branch to main tree as unstaged changes (default) or merge (`--merge`), clean up run worktree, and complete.

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
- Fresh planner revisions can authorize the executor without another task-grill; stale/manual tasks and non-check retries must pass task-grill first.
- Planner admission is conservative: the CLI preserves an omitted mode, repository `plannerMode` supplies the default, and built-in `auto` is the final fallback. Auto uses planner-lite only for short, explicitly documentation/maintenance-shaped goals without elevated-risk terms. Replans and non-initial planning use the full planner. `--planner-mode lite|full` explicitly overrides policy.
- Planner-lite preserves the planner result and transcript artifacts while omitting full grill, CodeGraph, and ADR discovery. It escalates through `needs_human` when focused scope or validation cannot be established.
- Executor isolation is a hard rail: the harness fingerprints tracked diff content plus non-ignored untracked paths/content before execution and compares it after both successful and failed invocations. This detects changes hidden by stable status labels, including already-dirty files. Parent mutation stops before checks, commit, apply, or merge and writes `parent-worktree-mutation.txt` plus failure analysis; user files are never silently restored.
- Agent invocation telemetry records duration, assistant turns, tool calls, and log bytes in `agent_invocation_finished` events so planner/executor latency can be separated from shell-check time.
- Task-grill and decision-grill share one preflight invocation when the agent supports the bundled contract. Their verdict ordering and legacy artifacts remain independent.
- Verifier and post-task review share one bundled review invocation only when admission detects drift. Verification is processed first; plan advice is ignored on verification failure, preserving executor/reviewer independence and retry semantics.
- Bundled phases reference one `context-capsule.md` per task turn. Contract-only decision and plan-review sections reuse that evidence instead of embedding a second copy of task JSON, assumptions, decisions, and event history.
- Tasks with no declared `scope` emit `scope_missing_warning`; the diff-scope rail is inactive for them.
- Scope rail blocks changed files outside declared task scope.
- Task kind, complexity, and verification risk are independent. `implementation` describes work nature and does not automatically raise complexity or verification cost.
- Verification admission uses declared scope, meaningful boundedness, actual changed paths, failures, architecture/complexity, path gates, and semantic `humanGates`. Bounded low-complexity documentation-only diffs can skip the verifier; normal code receives one vote; high-risk work receives three adversarial votes by default.
- `verification_profile_resolved` records risk, mode, votes, reasons, and evidence. Explicit `--verifier-votes` overrides automatic vote count; `--fast-verifier` can only skip a resolved low-risk change.
- Check/verifier failures retry until budget, then escalate to `needs_human`.
- Artifact-only discovery/investigation/zoom-out tasks are allowed to prove completion through artifacts/evidence instead of implementation validation commands.
- On every failure (checks, scope, verifier, rebase-checks), the harness writes `failure-analysis.json` to the run dir with phase, attempt, truncated reason, and diff stat. The path is stored in the task's `failureHistory` and injected into the next task-grill and replan planner prompts to break blind-retry loops.
- Runtime and agent-call budgets emit `budget_exhausted`.
- Replan budget (`--max-replans`, default 5) caps how many times task-grill can trigger replanning per session; exhaustion emits `replan_budget_exhausted` and escalates to `needs_human`.
- Convergence detection: if a replan produces the same task IDs as the previous replan, the loop emits `replan_convergence_failure` and halts.
- `--rebase-before-verify`: optional gate that rebases the worktree on loop-start HEAD and re-runs checks before the verifier, catching post-merge integration failures early.
- After each `ready` task-grill verdict, assumption evidence is persisted and emitted as `assumptions_updated`. Any non-empty `assumptionsChanged` immediately invalidates the current task, uses the shared budget/convergence-guarded replan transition, and prevents the stale executor from starting—even when it was the final task.
- `--goal-review` (opt-in): after all tasks pass, a goal-review agent judges the cumulative diff against `state.goal` and emits `goal_review_finished`. A `needs_human` verdict halts the loop before finalize-docs.
- Post-task plan review is default-on but admission-gated. It runs for verifier issues, high complexity, unscoped/overlapping work, or an always-review policy; assumption drift replans earlier. Otherwise `phase_skipped`/`post_task_review_skipped` preserves the trace without a model call.
- `autonomousLoop.phaseAdmission` controls the adaptive defaults: `taskGrill: plan-aware`, `verifier: auto`, `postTaskReview: on-drift`, `finalizeDocs: on-change`, and `retryTaskGrill: on-drift`.
- Finalize-docs is admission-gated on durable `.md`, `docs/`, `adrs/`, or `templates/` changes. A `phase_skipped` event records code-only completions without paying for a documentation agent.
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
- post-task review: drift admission runs it only when assumptions, verifier issues, complexity, or scope overlap justify review
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
- finalize-docs behavior (the phase-admission helper is covered; end-to-end docs-change coverage remains open)
- phase admission helper: planner freshness, retry, verifier, plan-review, and finalize-docs decisions
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
