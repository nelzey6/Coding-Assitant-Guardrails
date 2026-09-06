# ADR-0007: Compact execution with candidate-bound proof

## Status

Accepted

## Context

Historical extraction took 566 seconds, of which Executor used 109 and the compiler check less than one. The pending direct route still rejected extraction/move wording and repeated path aliases. Latency forecasts could invoke Planner again for an irreducible plan. Verification could accept diagnostic-only checks, lose human gates in voting, or commit reviewer edits after checks had run.

## Decision

1. Keep one run worktree and one lifecycle owner. Bounded concrete goals up to 1000 characters naming one to four files may execute directly. Extract/move/split/refactor requires explicit behavior preservation; elevated-risk and ambiguous language still requires Planner. Resolve shortened paths only against unique existing repository paths; distinct real files never collapse.
2. Admission owns compact execution selection. Bounded work without prior failure or high-risk evidence uses compact instructions, including code. A workflow label and file count alone never raise complexity. Explicit high complexity, protected paths, broad scope and semantic policy gates remain escalation evidence. Planner must justify high complexity with concrete behavioral uncertainty or impact.
3. Executor owns scoped documentation and local validation before review. Delete finalize-docs and its CLI/policy controls. No agent may mutate the result after task verification.
4. Keep independent verification for code. Verifier invocations guard both parent and candidate content/HEAD, including on error. Record candidate identity in review prompts. Any candidate mutation stops before commit and preserves evidence. These are detection guards, not an OS security sandbox.
5. Completion requires nonempty, non-diagnostic acceptance checks. Obvious no-ops are rejected; this is not a shell-language proof checker. Each passing code reviewer must map every acceptance criterion to an actually passed check and explain its proof. The independent reviewer owns semantic relevance; deterministic tests own executable evidence.
6. High-risk reviews remain concurrent, with distinct correctness, compatibility and proof/gate focuses. Wait for every launched reviewer before stopping. All reviewers must pass; any unresolved defect blocks acceptance and any human gate stops the run regardless of other votes. Gates remain in the aggregate result.
7. Bootstrap once per unchanged dependency input set. Hash package manifests, common lockfiles/package-manager configuration, commands and runtime/platform identity. Recheck after Executor and before checks. CLI omission inherits policy; explicit command overrides avoid probing unrelated installed agents.
8. Delete predictive latency forecasting and latency-triggered Planner repair. Keep measured phase/run durations and soft target overruns. Targets never admit another model phase or replace the hard runtime breaker.
9. Retain fresh execution sessions and existing transport adapters. Resumable repair, model routing and broader session infrastructure require controlled benchmark evidence before adoption.

## Consequences

Bounded mechanical code normally costs one Executor and one Verifier. Safety shifts toward the exact candidate and explicit proof. Bootstrap and documentation have one lifecycle owner. A simpler run module replaces speculative latency control and post-verification editing.

Tradeoffs: legitimate larger/pathless refactors still require Planner; old direct-result and verifier integrations must supply meaningful checks and validationEvidence; old --no-finalize-docs invocations must remove that flag. Existing workflows must include required documentation in scope. Test commands can still be irrelevant despite passing syntactic screening, so independent evidence review and project tests remain necessary. Live model latency and quality improvement require a paired benchmark; deterministic fixtures establish phase counts and behavior only.

## Supersedes

ADR-0005 documentation finalization and label/file-count escalation rules. ADR-0006 direct-route limits and latency forecasting/repair. Other isolation, retry, convergence and human-gate requirements remain.
