# ADR-0002: TypeScript Agent Loop With Per-Task Grill And Replan

## Status

Accepted

## Context

The first TypeScript CLI design kept `tools/agent-loop/` deterministic and left autonomous LLM orchestration in `scripts/agentic/agentic-loop.ps1`.

That split helped establish typed modules, but it did not satisfy the larger goal: productive autonomous execution where the harness can verify itself, adapt future prompts to feedback, and avoid blindly executing stale plan slices.

Large goals make a single up-front grill insufficient. By the time later tasks run, repository state, assumptions, validation evidence, and verifier feedback may have changed. The harness needs a fresh critical-thinking gate on every task turn.

## Decision

The TypeScript CLI is now the current autonomous runner architecture. It owns the `run` loop, including:

- planner invocation when tasks are absent or stale tasks request replanning
- per-task git worktree setup
- task-grill before every executor turn
- executor prompt generation and invocation
- validation/check execution
- diff-scope enforcement
- verifier prompt generation and invocation
- adversarial multi-vote verifier support for high-risk tasks
- retry budget handling
- `needs_replan` handling by blocking the stale task, invoking planner again, and continuing with replacement tasks
- operator diagnostics and review/accept/reset flows

Task-grill is a required pre-execution phase. It writes `task-grill-result.json` with verdict:

- `ready`: continue to executor
- `needs_replan`: block stale task, invoke planner, continue loop
- `needs_human`: stop before executor edits
- `blocked`: mark blocked and stop before executor edits

A `ready` result with non-empty `assumptionsChanged` is not executable readiness:
the harness persists the evidence, blocks the stale task, and invokes the same
budgeted/convergence-guarded replan path before any executor starts.

Executor prompts include the task-grill result so the executor starts from current task understanding rather than only from the original planner output.

## Consequences

Positive:

- Later tasks are re-understood in current repo state before edits.
- Stale tasks can be replaced without requiring a human to restart the loop.
- Verifier/check/scope feedback can appear in task-grill and executor context through recent event history.
- The TypeScript harness is easier to test than the PowerShell monolith; `tests/agentic/agent-loop-ts-smoke.ts` now covers task-grill stop and replan behavior.

Tradeoffs:

- Each task costs at least one extra agent call for task-grill.
- The planner can now run mid-loop, so planner prompts and result validation become part of the execution safety path.
- `blocked` is treated as a terminal task status for completion purposes. This supports stale-task replacement, but blocked tasks must carry enough failure history to explain why they are terminal.
- The setup scripts still install the PowerShell harness shim today, so repository docs must distinguish current TS architecture from legacy installed compatibility.

Performance clarification:

- A task is a verification slice, not a file-sized work item. Planner task splits must introduce a distinct risk profile, acceptance proof, ownership/scope seam, rollback value, or dependency. Mechanical edits sharing one proof should remain one task because every task pays the full grill, execution, verification, and plan-review cost.
- Logical phase isolation is defined by separate contracts, validation, ordering, and artifacts. It does not require every logical phase to remain a separate model invocation when multiple judgments consume the same evidence. Executor and reviewer independence must remain intact.
- Task-grill and decision-grill therefore run as one bundled preflight invocation by default. The harness validates task readiness first, accepts decisions only after a `ready` verdict, and falls back to a decision-only invocation when a legacy/custom agent writes only the task-grill artifact.
- Verifier and post-task review run as one bundled review invocation by default for single-vote verification. The harness processes verification first and uses remaining-plan advice only after a pass. Missing legacy artifacts trigger only the missing review call; adversarial verifier votes stay independent.
- Each task turn writes a canonical context capsule containing task JSON, operator context, assumptions, decisions, CodeGraph reference, and recent event delta. Bundled phase contracts reuse this artifact to keep shared evidence local and avoid repeating it across logical reviews.

## Known Follow-Ups

- Enforce clean-main-worktree policy in the TS `run` command.
- Honor policy defaults for retry count, merge mode, state file, worktree root, and runs root.
- Replace the TypeScript CodeGraph stub with real helper invocation.
- Add structured failure distillation and update `promptPolicy.lessons`.
- Add architect checkpointing across multi-task runs.
- Migrate installer shims from the PowerShell harness to the TypeScript runner when packaging is ready.
