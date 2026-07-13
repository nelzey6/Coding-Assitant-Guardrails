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
13. Append-only events, state snapshots, checks, diffs, and verifier JSON are the canonical run evidence. Routine task handovers, progress markdown, and final-summary markdown are not generated.
14. Planner-lite writes only planner JSON. Full Planner keeps the grill transcript because complex discovery needs human-readable decision evidence.
15. Pi transport persists compact operational events only: session identity, assistant/tool completion counts, aggregate whole-invocation token/cost usage, and bounded errors. It never stores repeated message history, thinking, tool arguments, or tool results.
16. Finalize-docs admission is limited to source-of-truth documentation paths (`PROJECT.md`, `CONTEXT.md`, agent guidance, `docs/`, `adrs/`, and `templates/`). An arbitrary root Markdown file such as `README.md` does not pay for another model pass.
17. Compact tasks do not generate CodeGraph context or initialize a repository index. Existing indexes are synchronized after applicable changes, but index creation is never an incidental run side effect.
18. Do not duplicate console output into a top-level run log. Phase logs and append-only events are the diagnostic sources; live console output remains available to the operator.

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
- Small runs produce less duplicated Markdown and bounded Pi logs while retaining machine-readable traceability.

Tradeoffs:

- Operators cannot force individual legacy phases or verifier vote counts.
- Manual task graphs without a current planner revision are replanned before execution.
- Remaining-plan drift must surface through stale revision, failure evidence, or a new goal run rather than periodic review agents.
- Finalize-docs has no independent second-pass verifier; its edits remain visible in the final diff.
- Compact Pi logs intentionally omit conversational content; detailed execution evidence lives in changed files, checks, diffs, result JSON, and failure analysis.

## Supersedes

- ADR-0001 deterministic planner interface
- ADR-0002 required per-task grill and review lifecycle
- ADR-0003 multi-round stance and post-task reflection design
- ADR-0004 retained phase implementations behind admission
