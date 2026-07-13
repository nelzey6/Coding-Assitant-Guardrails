# ADR-0005: Adaptive Core Loop Replaces Phase Ceremony

## Status

Accepted

## Context

Evidence-gated admission reduced model calls, but old phases, artifacts, fallback paths, CLI flags, state fields, and tests remained implemented. Small goals still carried a large implementation and maintenance cost even when runtime skipped most ceremony.

Task-grill, decision-grill, post-task review, architect checkpoint, and goal review overlapped Planner, stance reflection, and Verifier responsibilities. Legacy per-task review branches also coexisted with the newer shared run worktree.

## Decision

Use one adaptive core loop:

1. Planner owns goal understanding, questions, decisions, assumptions, task slicing, scope, and validation design.
2. Deterministic admission sends stale/manual tasks and understanding-sensitive failures directly back to Planner. Check failures retry directly.
3. High-complexity tasks run one stance-reflection invocation before edits.
4. Executor works in one shared run worktree.
5. Checks and scope rail run before verification.
6. One verification profile resolves skip, single, or three-vote adversarial mode.
7. Durable documentation changes admit one finalize-docs invocation without a second finalizer verifier.
8. Completion has one integration behavior: apply as unstaged changes, or retain with `--no-apply`.
9. Planner stamps tasks with a fingerprint of goal, decisions, assumptions, questions, and blockers. Context drift invalidates the plan before execution.
10. Every model phase crosses one protected invocation seam that detects parent HEAD/content mutation and preserves forensic evidence.
11. Verification admission emits only valid mode/vote pairs: skip/0, single/1, or adversarial/3. Single-root recursive scopes are broad, not low risk.
12. Effective planner mode is resolved once with traceable policy/adaptive source and reason. Human gates use structured matching rules with legacy-string compatibility.

Delete standalone task-grill, decision-grill, post-task review, architect checkpoint, goal review, bundled preflight/review, finalizer verifier, deterministic `plan`, review-branch lifecycle, and their compatibility fallbacks.

Keep worktree isolation, parent-checkout mutation detection, dependency ordering, bootstrap, checks, scope enforcement, risk admission, adversarial verification, retries, replan convergence, events, and failure analysis.

## Consequences

Positive:

- Normal clear task usually costs Planner, Executor, and at most one Verifier.
- Planner is the single owner of understanding and decisions.
- Admission is the single owner of escalation.
- CLI and policy expose fewer internal mechanics.
- State has one canonical schema and one run lifecycle.
- Tests exercise public behavior rather than deleted phase contracts.

Tradeoffs:

- Operators cannot force individual legacy phases or verifier vote counts.
- Manual task graphs without a current planner revision are replanned before execution.
- Remaining-plan drift must surface through stale revision, failure evidence, or a new goal run rather than periodic review agents.
- Finalize-docs has no independent second-pass verifier; its edits remain visible in the final diff.

## Supersedes

- ADR-0001 deterministic planner interface
- ADR-0002 required per-task grill and review lifecycle
- ADR-0003 multi-round stance and post-task reflection design
- ADR-0004 retained phase implementations behind admission
