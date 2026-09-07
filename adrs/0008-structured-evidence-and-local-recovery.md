# ADR-0008: Structured evidence and recovery at the failed stage

## Status

Accepted

## Context

Real-model extraction runs produced correct code but failed completion when reviewers reformulated a goal-shaped acceptance criterion. A full-repository run hid operator checks from Executor, accepted explanatory prose as a proposed shell command, spent another executor attempt repairing that command, and rejected the subsequent review. Both failed processes left tasks marked running and omitted terminal latency.

## Decision

1. Checks owns command resolution and structured results. Resolve operator, state and task commands before Executor. Preserve provenance, working directory and stable check identity; operator commands cannot be replaced by model additions. Direct Executor may return no additional commands when known checks suffice. Parse proposed commands with the execution shell without running them; do not remove prose or invent executable meaning.
2. Bind passing results to candidate HEAD/content. Record partial outcomes when later checks fail. A check that changes the candidate invalidates its evidence and stops the run. Stage new-file intent before taking the check snapshot so subsequent diff artifacts do not change representation. Recheck candidate identity before review and commit; no cross-run evidence cache.
3. Harness derives stable requirement IDs from task identity, requirement position and text. Reviewer references requirement/evidence IDs instead of retyping prose or commands. Behavior requires passed assertion-check evidence; structure may use the diff and relevant checks; documentation requires diff evidence and consistency with implementation. Independent review owns semantic adequacy, including compound requirements. IDs and syntax checks alone do not establish correctness.
4. Narrow review output to verdict, summary, defects, gates and coverage. Accept string defects or structured findings with file, triggering case and consequence, preserving their meaning without format repair. Derive acceptance status in the harness. Existing gates or defects cannot be erased through format repair. Unknown/stale references, missing coverage and evidence-free behavioral claims remain invalid.
5. Invalid Direct or Verifier result artifacts get at most one fresh, minimal repair invocation per artifact. Repair guards both parent and candidate, writes only the result, and consumes no code attempt. Real assertion failures keep the existing bounded code retry. Invalid configured checks, infrastructure failure or candidate mutation stop with retained evidence; human gates stop regardless of votes. Persistent sessions remain deferred.
6. One run owner records terminal outcome, failed stage, retained worktree and elapsed time for success and handled failure. Tasks cannot remain running after a handled run failure. Recording errors must not replace the original error. This does not implement crash recovery or durable automatic resume; abrupt process death still requires operator inspection.
7. Preserve single-worktree execution, parent/candidate mutation guards, scoped edits, meaningful operator checks, independent code review, and high-risk all-votes-pass semantics. Do not introduce agent roles, a workflow engine or phase-specific model configuration. Evaluate lower review effort using the existing custom adapter before changing defaults.

## Consequences

The existing run interface owns recovery without restarting code for protocol mistakes. Checks is the single source of executable evidence; prompts are views of that evidence. Command strings remain supported for shell compatibility, with descriptions kept out of executable fields. Legacy state criteria remain strings and IDs are derived; legacy reviewer artifacts remain diagnostic evidence but must be repaired to the coverage contract before acceptance.

Tradeoffs: artifact repair still costs a model invocation; review must judge relevance that deterministic ID validation cannot. Check mutation detection can reject tools that rewrite tracked artifacts during validation; such work must occur before checks. Automatic resume across invocations is not provided. Model latency/quality claims require live comparisons including failures and seeded defects.

## Supersedes

ADR-0007 clauses 5 and 9 concerning exact-command/prose proof representation and deferral of bounded artifact repair. ADR-0006 Direct completion no longer requires new commands when configured commands suffice. Other isolation, verification, convergence and human-gate requirements remain. Commit staging uses the validated literal file list; a live run showed that negative pathspecs for ignored dependency directories can fail after successful review.
