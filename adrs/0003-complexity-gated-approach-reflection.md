# ADR-0003: Complexity-Gated Technical Stance Reflection

## Status

Accepted

## Context

The loop already grills task readiness, resolves genuine decisions, verifies completed work, and reassesses the remaining plan. It did not explicitly distinguish task complexity or require a fresh technical challenge of a complex implementation stance before edits.

Task-grill cannot own this concern without mixing readiness with architecture design. Decision-grill resolves choices but does not iteratively refine an implementation route. The periodic architect checkpoint overlaps the existing post-task plan review and runs too late to prevent a weak stance from shaping implementation.

## Decision

Tasks may declare `complexity`, `complexityReasons`, and planned `reflectionCheckpoints`. The harness deterministically escalates complexity and never lowers the planner's proposal.

Before a high-complexity task reaches the executor, the harness runs `reflect-on-approach` in stance mode in a clean worktree. It requires at least two fresh rounds, allows up to three, rejects repository edits, writes `approved-stance.json`, and injects the approved stance into the executor prompt.

Post-task plan review uses `reflect-on-approach` in plan mode. The periodic architect checkpoint remains available for compatibility but is disabled by default because plan review already owns remaining-plan drift.

True fresh-agent implementation checkpoints require a resumable executor lifecycle. Checkpoint metadata is introduced now, but checkpoint execution is deferred rather than simulated inside one unrestricted executor call.

## Consequences

- Complex work receives explicit technical reassessment before edits.
- Readiness, technical stance, correctness, and plan validity remain separate responsibilities.
- High-complexity tasks cost at least two additional agent calls.
- Existing task files remain backward compatible because complexity metadata is optional and deterministically resolved.
- Milestone checkpoint execution needs a later executor-resume design.
