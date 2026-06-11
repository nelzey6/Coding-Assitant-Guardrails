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
```

Known environment note: local Node runs may print a warning about `NODE_EXTRA_CA_CERTS` pointing at a missing Zscaler PEM. The warning does not fail the TS typecheck or smoke suite.

## Architecture

### Main Surfaces

| Path | Role |
| --- | --- |
| `tools/agent-loop/src/index.ts` | Commander CLI entry point. Defines `validate`, `plan`, diagnostics, `accept`, `reset-task`, and `run`. |
| `tools/agent-loop/src/loop/index.ts` | Autonomous run engine. Owns planner, task-grill, executor, checks, scope rail, verifier, replan, commit/merge, handover, and finalize-docs phases. |
| `tools/agent-loop/src/prompts/index.ts` | Prompt builders for planner, task-grill, executor, verifier, finalize-docs, and prompt budget trimming. |
| `tools/agent-loop/src/state/index.ts` | `agentic.json` schema helpers, task selection, task status changes, attempts, failure history, and planner result merge. |
| `tools/agent-loop/src/agent/index.ts` | Agent invocation adapters for `claude`, `pi`, and custom command templates. |
| `tools/agent-loop/src/checks/index.ts` | Validation command execution, timeout handling, structured `METRIC key=value` parsing. |
| `tools/agent-loop/src/scope/index.ts` | Scope glob matching, out-of-scope diff detection, fast-verifier eligibility, high-risk task detection. |
| `tools/agent-loop/src/events/index.ts` | `.agent-runs/events.jsonl` append/load/format helpers. |
| `tools/agent-loop/src/reporting/index.ts` | Human/JSON output for status, summary, last-failure, why-stuck, doctor, reset, and accept. |
| `tools/agent-loop/src/policy/index.ts` | Loads workflow policy from `.agent-policy/workflow-policy.json` or `templates/agent-policy/workflow-policy.json`. |
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

## Autonomous Run Flow

The current TS run loop is:

1. Load policy and `agentic.json`.
2. If no tasks exist, run planner. Planner must write `planner-result.json` and `grill-transcript.md`.
3. Pick next runnable task: `pending` or `needs_retry` with passed dependencies.
4. Create or reuse `.worktrees/<task-id>` on `agentic/<task-id>` or `agentic/review/<task-id>`.
5. Run task-grill before executor edits.
6. If task-grill returns `ready`, inject its result into executor prompt and run executor.
7. If task-grill returns `needs_replan`, mark stale task `blocked`, record `task_replan_requested`, run planner again, and continue to replacement tasks.
8. If task-grill returns `needs_human` or `blocked`, stop before executor edits.
9. Run configured checks from state-level `checks`, task `validation`, and CLI `--checks`.
10. Enforce declared task `scope` by diffing changed files before verifier review.
11. Run verifier unless `--fast-verifier` is requested and allowed for a low-risk scoped task.
12. For high-risk tasks, run adversarial verifier votes unless overridden.
13. On pass, optionally commit/merge or retain review branch/worktree.
14. Write handover/progress artifacts.
15. When no runnable tasks remain, treat `passed` and `blocked` as terminal statuses. If all unfinished work is terminal, complete.

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

- One task per isolated worktree/branch.
- Harness owns task status, verifier result handling, commit, merge, and cleanup.
- Task-grill must pass before executor runs.
- Scope rail blocks changed files outside declared task scope.
- Fast verifier is denied unless task kind is low-risk and scope is declared.
- High-risk tasks can receive multiple adversarial verifier votes.
- Check/verifier failures retry until budget, then escalate to `needs_human`.
- Runtime and agent-call budgets emit `budget_exhausted`.
- `accept` and `reset-task` are dry-run by default and require `--apply` to mutate.

Known gaps before calling the TS runner production-default:

- `run` does not yet enforce the policy clean-main-worktree gate.
- CLI defaults do not fully honor policy defaults such as retry count and merge mode.
- CodeGraph context generation in TS currently writes a fallback stub instead of invoking the helper.
- `promptPolicy.lessons` exists in state but is not yet updated as structured learning memory.
- Architect-level checkpointing across multiple passed tasks is not yet implemented.
- Installer shims still install the PowerShell harness, not the TS runner.

## Validation Coverage

`tests/agentic/agent-loop-ts-smoke.ts` currently covers:

- happy path task execution and verifier pass
- task-grill result injection into executor prompt
- task-grill `needs_human` stop before executor edits
- task-grill `needs_replan` planner loop and replacement task execution
- scope violation blocking
- scope clean pass
- fast-verifier denied for high-risk task
- fast-verifier allowed for low-risk scoped task
- check failure retry then pass
- verifier failure retry budget exhaustion to `needs_human`

Missing TS smoke coverage:

- real `claude` / `pi` commands
- planner phase from empty task list outside the replan case
- finalize-docs behavior
- accept/apply/review-branch flows
- doctor/reset commands
- runtime/agent-call budget exhaustion
- policy default adoption
- clean-tree gate

## Documentation Truth

Root ADRs live in `adrs/`. `docs/adr/` contains older ADRs and should not receive new decisions.

`scripts/agentic/agentic-loop.ps1` remains the legacy/reference PowerShell harness and is still what setup scripts install as the `agentic-loop` shim today. The TS runner under `tools/agent-loop/` is the current typed architecture being evolved toward the productive autonomous harness.

## Repository Constraints

- Skills in `engineering/`, `productivity/`, and `misc/` must be linked from top-level `README.md`, bucket `README.md`, and `.claude-plugin/plugin.json`.
- Skills in `personal/`, `in-progress/`, and `deprecated/` must not be exposed in those surfaces.
- Do not modify upstream-derived skills from `mattpocock/skills`; put local behavior in local files/skills/templates.
- Do not commit `.agent-runs/`, `.worktrees/`, `.codegraph/`, or local runtime state.
