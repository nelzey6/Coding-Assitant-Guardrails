# ADR-0006: Impact-Routed Execution With Soft Latency Budgets

## Status

Partially superseded by [ADR-0007](./0007-proof-bound-execution.md): direct-route limits, forecasting and latency repair.

## Context

The adaptive core loop removed many phases, but every empty goal still paid for Planner before Executor. For small, explicit edits this duplicated task understanding and made the harness feel much slower than a normal goal run. Complex plans could also multiply execution sessions through artificial task slicing even when every slice used the same proof.

Runtime must become reactive without weakening fresh-session isolation, checks, scope enforcement, risk-based stance reflection, or independent verification.

## Decision

1. Deterministic impact routing runs before Planner.
2. A goal may execute directly only when initial state has no tasks, questions, or blockers; goal is at most 400 characters; it names one or two repository-relative files; it contains a concrete edit action; and it contains no ambiguous, elevated-risk, or human-gated language.
3. Direct routing installs one synthetic low-complexity primary task. Named files become hard scope; goal text becomes acceptance criteria.
4. Direct Executor uses one fresh session and performs a short inline plan. It must write `direct-execution-result.json` with `completed`, `needs_planner`, or `needs_human`, plus summary, focused validation commands, and assumptions.
5. `completed` requires one to three focused commands. Harness reruns them, enforces scope, resolves verification from actual diff, and follows normal commit/apply flow. Documentation-only diffs may skip Verifier; code keeps at least one independent Verifier.
6. `needs_planner` is accepted only with a clean run worktree. Any prior edit stops as `needs_human`; clean escalation blocks synthetic task and starts a fresh full Planner session.
7. Invalid or missing direct results use bounded task retry policy.
8. Full Planner produces exactly one primary implementation slice. It may add one prerequisite only when primary depends on it, validation is distinct, and split reason is `distinct-proof`, `true-prerequisite`, or `independent-rollback`. Standalone discovery is rejected unless goal itself requests investigation or an artifact.
9. Policy owns soft latency targets: 60 seconds direct, 180 seconds planned, and 300 seconds complex. Phase targets are Planner 40, stance 35, Executor 140, checks 25, Verifier 45, and finalize-docs 15 seconds.
10. Forecasts use historical phase durations from `events.jsonl`; policy targets provide fallback estimates. Over-target plans get one fresh Planner repair request to collapse unnecessary slices. Persistent overrun is recorded and execution continues.
11. Soft targets never kill an active phase or skip required checks, scope, stance, verification, or human gates. `--max-runtime-seconds` remains the separate hard circuit breaker.
12. Every model phase remains a fresh session. Three adversarial Verifier votes remain concurrent.
13. TypeScript harness owns routing and latency behavior. Legacy PowerShell stays compatibility-tested and does not duplicate these mechanisms.

## Consequences

Positive:

- Small bounded goals normally remove Planner wall time.
- Direct work still traverses existing checks, scope, risk, verifier, commit, and apply rails.
- Complex work defaults to one coherent implementation session instead of file-shaped task graphs.
- Forecast and phase events make latency pressure traceable without adding CLI controls.
- Fresh-session independence remains intact.

Tradeoffs:

- Deterministic admission is intentionally conservative; many short but vague goals still pay for full Planner.
- Executor-proposed commands become trusted validation input, bounded to three commands and rerun by harness.
- Historical forecasts are estimates, not deadlines; slow providers may exceed targets without interruption.
- A legitimate prerequisite may still exceed planned target and produce a traceable overrun after one unsuccessful collapse attempt.

## Builds On

- ADR-0005 adaptive core loop
