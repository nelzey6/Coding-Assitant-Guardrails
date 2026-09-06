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

Before Planner, impact routing admits only concrete goals up to 1000 characters naming one to four repository-relative files, with no ambiguity, elevated-risk language, open questions, blockers, or human gates. It installs one Direct task. Everything else enters full Planner.

Direct Executor writes `direct-execution-result.json`. Completion requires one to three focused commands, rerun by harness. Clean `needs_planner` starts a fresh full Planner; dirty `needs_planner` stops. Missing/invalid result uses bounded retry policy.

Full Planner emits exactly one Primary slice. It may add one Prerequisite only when Primary depends on it, validation differs, and split reason states distinct proof, true prerequisite, or independent rollback. Discovery stays inside Primary unless goal itself is investigation/artifact work.

A task executes only when its revision and planning context still match and no ambiguity remains. Changed goal, decisions, assumptions, questions, or blockers invalidate it before execution. Check failures keep the same planner revision and retry directly.

## Risk and verification

Verification profile uses:

- task complexity
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

Mechanical extract/move/split/refactor routing requires explicit behavior preservation. Unique existing path aliases are normalized. File count and workflow names alone do not trigger high complexity. Compact code tasks use existing checks without forcing TDD ceremony.

Empty and diagnostic-only proof is rejected. Passing code Verifier results require `validationEvidence: [{criterion, command, proves}]`, covering every exact acceptance criterion with an actual passed command. The reviewer assesses semantic relevance; syntactic screening is not a correctness proof. All high-risk reviewers must pass; unresolved defects cannot be outvoted, and human gates take precedence. Candidate HEAD/content is guarded throughout each review, including failed reviews, and all launched reviews settle before stopping.

## Worktree safety

Harness creates one worktree per run. Every agent invocation snapshots protected parent HEAD and content before and after execution. Planner, stance, executor, and verifier mutations to parent checkout stop the run and write forensic evidence. Guard detects tracked, untracked, already-dirty, error-exit, and HEAD-only mutations; it never auto-restores them.

Bootstrap commands run inside worktree once per dependency fingerprint, and again after dependency input changes before checks. CLI omission inherits policy. Declared artifacts stay excluded from diff, scope and commits.

## Failure behavior

- checks/scope/verifier failure → `needs_retry` until policy retry limit, then `needs_human`
- executor/harness/isolation failure → `needs_human`
- stale understanding → block current task, enforce replan budget and convergence guard, call planner
- planner ambiguity → stop before worktree execution

Each failure writes `failure-analysis.json`. Events append to `.agent-runs/events.jsonl`.

Pi JSON transport logs only session metadata, assistant/tool completion summaries, aggregate whole-invocation token/cost usage, and bounded errors. It omits message history, thinking, tool arguments, and tool results. Compact tasks do not generate CodeGraph context or initialize `.codegraph/`.

## Latency

Policy defaults:

| Route/phase | Soft target |
| --- | ---: |
| Direct run | 60s |
| Planned run | 180s |
| Complex run | 300s |
| Planner | 40s |
| Stance | 35s |
| Executor | 140s |
| Checks | 25s |
| Verifier | 45s |

Measured phase/run durations emit overrun events against soft targets. Forecasting and latency-triggered Planner repair are removed. Soft targets do not interrupt active phases or bypass proof; `--max-runtime-seconds` remains the breaker. Sessions stay fresh; high-risk reviewer sessions run concurrently with different focuses.

## Completion

Passed tasks commit inside run branch. After final task:

- required documentation is already completed by Executor within scope and checked before review
- default → copy branch files into parent as unstaged changes, clean worktree/branch
- `--no-apply` → retain run worktree/branch

Routine handover, progress, final-summary Markdown, and duplicate top-level run logs are not generated; use state, phase logs, events, checks, diffs, and result JSON for traceability.

## Removed interfaces

Removed intentionally: `plan`, `doctor`, `reset-task`, `accept`, review branches, merge modes, targeted retry selector, explicit verifier votes, fast-verifier, rebase-before-verify, task-grill, decision-grill, post-task review, architect checkpoint, goal review, finalize-docs (including `--no-finalize-docs`), and finalizer verifier.
