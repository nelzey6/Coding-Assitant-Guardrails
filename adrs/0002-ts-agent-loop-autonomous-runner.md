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

## Known Follow-Ups

- Enforce clean-main-worktree policy in the TS `run` command.
- Honor policy defaults for retry count, merge mode, state file, worktree root, and runs root.
- Replace the TypeScript CodeGraph stub with real helper invocation.
- Add structured failure distillation and update `promptPolicy.lessons`.
- Add architect checkpointing across multi-task runs.
- Migrate installer shims from the PowerShell harness to the TypeScript runner when packaging is ready.
