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

Each role starts a clean session. Native Pi explicitly uses `--no-session`; ordinary single review requests `off` extended thinking. A first bounded Direct Executor attempt also requests off. Planned execution, retries, Planner and adversarial review retain configured effort. Custom commands own their session and reasoning settings. No Executor conversation is passed into review; candidate evidence carries continuity. Ordinary native Pi review enables read, grep, find, ls and write only: the harness owns shell checks, and the reviewer inspects assertions and writes its result. High-risk review and explicit command templates retain their tools. Candidate/parent guards still apply.

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

Direct Executor receives the resolved operator/state/task checks and writes `direct-execution-result.json`. It may propose zero to three `additionalChecks: [{command, reason?}]`; reports belong in summary and command contains executable shell only. Legacy `validation: string[]` remains readable; no additions are required when known checks suffice. Proposed shell syntax is parsed before execution. Clean `needs_planner` starts a fresh full Planner; dirty `needs_planner` stops. Missing/invalid results get one guarded artifact-only repair without another code attempt.

Full Planner emits exactly one Primary slice. It may add one Prerequisite only when Primary depends on it, validation differs, and split reason states distinct proof, true prerequisite, or independent rollback. Discovery stays inside Primary unless goal itself is investigation/artifact work.

A task executes only when its revision and planning context still match and no ambiguity remains. Changed goal, decisions, assumptions, questions, or blockers invalidate it before execution. Code assertion failures keep the same planner revision and retry directly. Configuration/environment failures and candidate mutation stop with retained evidence. `lastRun`, `run_finished` and `run_latency` record terminal outcome, failed stage, retained worktree and elapsed time on success and handled failure; stopped tasks do not remain running. This does not provide automatic crash recovery or cross-run resume.

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

Empty and diagnostic-only behavioral proof is rejected. Checks records candidate-bound results in `check-evidence.json`. Review uses `coverage: [{criterionId, kind, evidenceIds, proves}]` against harness-owned requirements and evidence in `review-evidence.json`; kind is behavior, structure or documentation. Behavior requires passed assertion evidence, documentation is deterministically bound to the candidate diff (omit evidenceIds), and the reviewer judges semantic coverage. Legacy documentation references are ignored; behavioral and structural references remain explicit and validated. Prose is not an identifier. Invalid review artifacts get one read-only repair; existing defects/gates cannot be repaired away. Syntax and ID checks are not correctness proofs. All high-risk reviewers must pass; unresolved defects cannot be outvoted, and human gates take precedence. Candidate HEAD/content is guarded throughout each review, including failed reviews, and all launched reviews settle before stopping.

## Worktree safety

Harness creates one worktree per run. Every agent invocation snapshots protected parent HEAD and content before and after execution. Planner, stance, executor, and verifier mutations to parent checkout stop the run and write forensic evidence. Guard detects tracked, untracked, already-dirty, error-exit, and HEAD-only mutations; it never auto-restores them.

Bootstrap commands run inside worktree once per dependency fingerprint, and again after dependency input changes before checks. CLI omission inherits policy. Declared artifacts stay excluded from diff, scope and commits. Commit staging uses the validated changed-file list rather than negative pathspecs for ignored dependency directories.

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
