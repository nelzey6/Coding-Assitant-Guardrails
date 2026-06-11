# Agentic Loop — How It Works

The agentic loop is an autonomous coding harness that turns a goal into small, safe tasks and executes them one at a time in isolated git worktrees. A fresh agent is spawned for each phase so context never bleeds between tasks.

---

## High-level phases

```
Goal
 │
 ▼
┌─────────────┐
│  Discovery  │  grill-with-docs: inspect repo, resolve decisions, stop for human input only when necessary
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Planning  │  split goal into small tasks, each assigned one canonical workflow
└──────┬──────┘
       │  (loop per task)
       ▼
┌─────────────┐
│  Task-Grill │  fresh agent: is the task still valid, scoped, and safe?
└──────┬──────┘
       │ ready / needs_replan / needs_human / blocked
       ▼
┌─────────────┐
│  Execution  │  fresh agent runs inside an isolated git worktree/branch
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Checks    │  run configured validation commands + task smoke tests
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Verification│  fresh verifier agent (or multi-vote for high-risk tasks)
└──────┬──────┘
       │ pass / fail / needs_human
       ▼
┌─────────────┐
│  Reflection │  persist lessons, handover notes, assumption updates
└──────┬──────┘
       │
       ▼
    Merge or
    hold for review
```

---

## Full loop — Mermaid flowchart

```mermaid
flowchart TD
    GOAL([fa:fa-flag Goal]) --> LOAD[Load agentic.json\nor create from --goal]

    LOAD --> HAS_TASKS{Tasks exist?}
    HAS_TASKS -- No --> PLANNER[Planner agent\ngrill-with-docs discovery\nwrites grill-transcript.md]
    PLANNER --> PLAN_VALID{Plan valid?\nbudget + complexity check}
    PLAN_VALID -- Fail --> PLANNER
    PLAN_VALID -- OK --> PICK
    HAS_TASKS -- Yes --> PICK

    PICK[Pick next pending /\nneeds_retry task] --> NO_TASK{Any task\nrunnable?}
    NO_TASK -- No --> DONE([fa:fa-check Done])
    NO_TASK -- Yes --> WORKTREE[Create git worktree\n.worktrees/task-id\non branch agentic/task-id]

    WORKTREE --> GRILL[Task-Grill agent\nre-inspect repo + history\nbefore any edits]

    GRILL --> VERDICT{Verdict?}
    VERDICT -- needs_human --> STOP_H([fa:fa-user Human gate\nmark needs_human])
    VERDICT -- blocked --> STOP_B([fa:fa-ban Blocked\nstop before edits])
    VERDICT -- needs_replan --> REPLAN[Mark task blocked\nrun Planner again]
    REPLAN --> REPLAN_BUDGET{Replan\nbudget OK?}
    REPLAN_BUDGET -- Exhausted --> STOP_H
    REPLAN_BUDGET -- OK --> CONVERGENCE{Same task IDs\nas last replan?}
    CONVERGENCE -- Yes --> STOP_H
    CONVERGENCE -- No --> PICK

    VERDICT -- ready --> EXECUTOR[Executor agent\nruns inside worktree\nfollows canonical SKILL.md]

    EXECUTOR --> SCOPE{Scope declared?}
    SCOPE -- No --> WARN[emit scope_missing_warning\nloop continues]
    WARN --> CHECKS
    SCOPE -- Yes --> SCOPE_RAIL{Changed files\noutside scope?}
    SCOPE_RAIL -- Yes --> RETRY_SCOPE[scope_violation\nretry with offending paths]
    RETRY_SCOPE --> RETRY_BUDGET{Retry\nbudget OK?}
    RETRY_BUDGET -- Exhausted --> STOP_H
    RETRY_BUDGET -- OK --> GRILL
    SCOPE_RAIL -- No --> CHECKS

    CHECKS[Run validation commands\nglobal checks + task.validation\nparse METRIC lines] --> CHECKS_OK{Checks pass?}
    CHECKS_OK -- Fail --> RETRY_CHK[record failureHistory\nneeds_retry or needs_human]
    RETRY_CHK --> RETRY_BUDGET2{Retry\nbudget OK?}
    RETRY_BUDGET2 -- OK --> GRILL
    RETRY_BUDGET2 -- Exhausted --> STOP_H
    CHECKS_OK -- Pass --> VERIFIER

    VERIFIER{High-risk\ntask?}
    VERIFIER -- Yes --> MULTI_VOTE[Multi-vote verifier\nN independent refute-first\nagents, majority pass required]
    VERIFIER -- No --> SINGLE[Single verifier agent]
    MULTI_VOTE --> VER_RESULT{Verdict?}
    SINGLE --> VER_RESULT

    VER_RESULT -- needs_human --> STOP_H
    VER_RESULT -- fail --> RETRY_CHK
    VER_RESULT -- pass --> MERGE

    MERGE{Merge mode?}
    MERGE -- ff-only / cherry-pick / no-ff --> COMMIT[Commit + merge\ntask branch → main]
    MERGE -- no-merge / review-branch --> HOLD[Hold branch for\nhuman review\n--accept to integrate]
    COMMIT --> REFLECT
    HOLD --> REFLECT

    REFLECT[Persist assumptions\nwrite handover.md\nupdate state] --> FINALIZE{All tasks\ndone?}
    FINALIZE -- No --> PICK
    FINALIZE -- Yes --> FINAL_DOCS[Finalize docs\nupdate PROJECT.md\nwrite final-summary.md]
    FINAL_DOCS --> DONE
```

---

## What each phase does

### Discovery (Planner)
The planner uses `grill-with-docs` style reasoning: it restates the goal, inspects repo docs and code for evidence, and resolves decisions autonomously. It only stops for human input when a product or domain decision cannot be safely invented. The output is `agentic.json` with a task list and `grill-transcript.md` as a visible audit trail.

### Task-Grill
Before every executor turn, a fresh agent re-reads the repo and recent loop history and answers: *Is the task still understood, correctly scoped, and safe to execute right now?* Possible verdicts:

| Verdict | Harness action |
| --- | --- |
| `ready` | Inject result into executor prompt and proceed. |
| `needs_replan` | Mark task blocked, re-run planner, continue with replacement tasks. |
| `needs_human` | Stop before edits, surface the decision. |
| `blocked` | Stop before edits, record the blocker. |

### Execution
A fresh executor agent works inside an isolated git worktree on a dedicated branch. It reads `AGENTS.md`/`CLAUDE.md`, follows the canonical `SKILL.md` for the selected workflow (e.g. `tdd`, `diagnose`, `improve-codebase-architecture`), and produces a diff. The harness — not the agent — owns task status, merges, and cleanup.

### Checks
The harness runs every command in `agentic.json` `checks`, task `validation`, and CLI `--checks`. Commands may emit `METRIC key=value` lines for structured observability. Failures trigger retry (up to `--max-retries`) before escalating to `needs_human`.

### Scope rail
If a task declares a `scope` glob list, the harness diffs changed files after the executor and before the verifier. Any file outside scope is a retryable failure with the offending paths fed back into the next task-grill prompt. Tasks with no scope emit a warning but still proceed.

### Verification
A fresh verifier agent reads the task JSON, acceptance criteria, diff, checks output, and human-gate list from the policy. For high-risk tasks (implementation/architecture with a declared scope or matching a human-gate path), multiple independent "refute-first" verifier agents vote; a majority pass is required.

### Reflection
The harness persists `assumptionsStillValid`/`assumptionsChanged` back into `state.assumptions`, writes `handover.md` for future agents, and appends lifecycle events to `.agent-runs/events.jsonl`.

---

## Key files on disk

| File / Path | Purpose |
| --- | --- |
| `agentic.json` | Task graph and loop state for the current goal. |
| `.agent-runs/events.jsonl` | Append-only lifecycle event log (audit/debug). |
| `.agent-runs/<run>/grill-transcript.md` | Planner's visible Q&A and evidence trail. |
| `.agent-runs/<run>/task-grill.md` | Task-grill prompt (re-understanding gate). |
| `.agent-runs/<run>/task-grill-result.json` | Task-grill structured verdict. |
| `.agent-runs/<run>/executor.md` | Executor prompt (includes task JSON + task-grill result). |
| `.agent-runs/<run>/verifier.md` | Verifier prompt (includes diff, checks output, human gates). |
| `.agent-runs/<run>/verifier-result.json` | Verifier verdict: `pass`, `fail`, or `needs_human`. |
| `.agent-runs/<run>/handover.md` | Continuation note for the next agent turn. |
| `.agent-runs/<run>/failure-analysis.json` | Phase/attempt/reason/diff-stat on every failure. |
| `.worktrees/<task-id>/` | Isolated git worktree for one task's edits. |

---

## Safety defaults at a glance

- Main worktree stays clean — one task per isolated branch/worktree.
- Harness (not the executor) marks pass/fail and merges.
- Task-grill must return `ready` before any edits happen.
- Scope rail blocks out-of-scope file changes before the verifier sees them.
- Fast verifier requires low-risk task kind + declared scope.
- Retry budget prevents infinite loops; exhaustion escalates to `needs_human`.
- Replan budget + convergence detection prevent the planner from cycling.
- Human gates from `.agent-policy/workflow-policy.json` are checked by the verifier.

---

## Related docs

- [Root README](../README.md) — quick start, install, and which workflow to use
- [PROJECT.md](../PROJECT.md) — TS architecture map, module table, and validation coverage
- [agentic-loop SKILL.md](../skills/engineering/agentic-loop/SKILL.md) — skill contract and routing rules
- [scripts/agentic/README.md](../scripts/agentic/README.md) — legacy PowerShell harness command reference
- [ADR-0002](../adrs/0002-ts-agent-loop-autonomous-runner.md) — architecture decision for the TS runner
