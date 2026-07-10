# ADR-0004: Evidence-Gated Agentic Phases

## Status

Accepted

## Context

The loop preserved strong traceability, but every task paid for nearly every
reasoning phase. Small goals therefore felt like a long ceremony instead of a
single `/goal` action. The expensive phases are useful when their triggering
evidence exists, but redundant when the planner has just established a clear
task and deterministic checks can prove a low-risk result.

## Decision

Use policy-driven phase admission with these defaults:

- `taskGrill: plan-aware`: a task stamped by the current planner revision skips
  task-grill when there are no open questions, blockers, or drift signals.
- `verifier: auto`: low-risk, scoped maintenance/discovery/investigation tasks
  can use passed checks as their verifier result; implementation and high-risk
  work retain verifier review and adversarial votes where configured.
- `postTaskReview: on-drift`: review the remaining plan only for changed
  assumptions, verifier issues, high complexity, unscoped work, or overlapping
  scopes. Bundle it with verifier only when deterministic evidence already
  admits it; otherwise keep verifier single-purpose.
- `retryTaskGrill: on-drift`: check failures retry directly; failures from
  understanding-sensitive phases re-run task-grill.
- `finalizeDocs: on-change`: invoke finalize-docs only when durable Markdown,
  docs, ADR, or template paths changed.

Every admission decision emits `phase_admitted` or `phase_skipped` with a
reason. Planner ambiguity emits `goal_intake_needs_human` before execution.

## Consequences

- Small clear tasks usually remove task-grill, decision-grill, post-task review,
  and finalize-docs model calls while preserving artifacts and event history.
- Complex, ambiguous, failed, or overlapping work still escalates into the
  existing reflection, replanning, retry, and verification rails.
- Planner revisions and task failure records become part of the readiness
  contract, so state transitions must stamp and preserve those fields.
- Operators can restore ceremony through policy or existing phase flags when a
  task class requires it.
