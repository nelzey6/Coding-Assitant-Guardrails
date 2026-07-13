# Agentic Loop Reference

## Start

```bash
cd tools/agent-loop
npm run agent -- init "describe the goal"
npm run agent -- run --checks "targeted validation command"
```

## Run options

```text
--repo <path>
--command <template>
--agent-timeout <seconds>
--check-timeout <seconds>
--max-runtime-seconds <seconds>
--checks <command>                    repeatable
--worktree-bootstrap <command>        repeatable
--worktree-bootstrap-ignore <path>    repeatable
--check-env-file <path>
--allow-dirty
--no-apply
--no-finalize-docs
```

`{prompt}` in a custom command receives the prompt file path. Without `--command`, harness detects Pi then Claude.

## Other commands

```bash
npm run agent -- validate
npm run agent -- init "goal"
npm run agent -- status
npm run agent -- summary
npm run agent -- last-failure
npm run agent -- why-stuck
npm run agent -- run
```

## State

`agentic.json` stores goal, task graph, checks, decisions, assumptions, questions, blockers, plan revision, and task statuses. Planner stamps each task with `plannedRevision` and a planning-context fingerprint.

A task executes only when its revision and planning context still match and no ambiguity remains. Changed goal, decisions, assumptions, questions, or blockers invalidate it before execution. Check failures keep the same planner revision and retry directly.

## Risk and verification

Verification profile uses:

- task complexity
- architecture intent
- meaningful declared scope
- actual changed paths
- previous failures
- human-gate paths
- semantic policy gates

Profiles:

| Risk | Mode |
| --- | --- |
| Low | Passed checks; verifier skipped |
| Medium | One verifier |
| High | Three adversarial votes |

Catch-all and single-root recursive scopes such as `src/**` never qualify as bounded low risk. Policy human gates may use structured `label`, `all`, and `any` rules; legacy strings remain readable.

## Worktree safety

Harness creates one worktree per run. Every agent invocation snapshots protected parent HEAD and content before and after execution. Planner, stance, executor, verifier, and finalizer mutations to parent checkout stop the run and write forensic evidence. Guard detects tracked, untracked, already-dirty, error-exit, and HEAD-only mutations; it never auto-restores them.

Bootstrap commands run inside worktree. Declared bootstrap artifacts are ignored by diff, scope, and commit handling.

## Failure behavior

- checks/scope/verifier failure → `needs_retry` until policy retry limit, then `needs_human`
- executor/harness/isolation failure → `needs_human`
- stale understanding → block current task, enforce replan budget and convergence guard, call planner
- planner ambiguity → stop before worktree execution

Each failure writes `failure-analysis.json`. Events append to `.agent-runs/events.jsonl`.

## Completion

Passed tasks commit inside run branch. After final task:

- durable docs changed → one finalize-docs call; reject non-doc edits and commit accepted docs before apply
- default → copy branch files into parent as unstaged changes, clean worktree/branch
- `--no-apply` → retain run worktree/branch

## Removed interfaces

Removed intentionally: `plan`, `doctor`, `reset-task`, `accept`, review branches, merge modes, targeted retry selector, explicit verifier votes, fast-verifier, rebase-before-verify, task-grill, decision-grill, post-task review, architect checkpoint, goal review, and finalizer verifier.
