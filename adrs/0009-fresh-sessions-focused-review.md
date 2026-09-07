# ADR-0009: Fresh sessions with focused independent review

## Status

Accepted

## Context

The harness already eliminated routine planning, finalization and duplicate review for bounded tasks. A real extraction still took 197 seconds, including 125 seconds in its independent reviewer, versus about 79 seconds in a guarded single-executor baseline. A separate medium-effort reviewer pilot completed in 44 seconds and caught a seeded semantic defect. These small samples justify evaluation, not a general speed or quality guarantee.

The user explicitly requires separate clean model sessions. Reusing one conversation would remove an intended advantage and is not the target architecture.

## Decision

Keep one goal and candidate evidence across fresh role invocations. Executor owns edits, deterministic checks establish observed results, and a separate Verifier judges correctness and evidence adequacy. Planner, stance and repair retain their existing evidence-based admission; no new role or orchestrator layer is introduced.

Native Pi starts ephemeral sessions explicitly. Ordinary single review uses medium reasoning; a first bounded Direct Executor attempt also uses medium. Planned execution, retries, planning and high-risk adversarial votes retain configured reasoning. Existing compact admission excludes failures and high risk; this reuses that decision rather than introducing another classifier. The run owner supplies the bounded-execution hint; the existing adapter owns native invocation details. Explicit command templates retain operator control and are not rewritten. Claude behavior is unchanged. No phase-specific CLI configuration matrix is added.

Ordinary native Pi review enables read, grep, find, ls and write only. The harness owns shell execution; review cannot silently repeat checks or start another implementation experiment. High-risk votes and explicit command templates keep their tool settings. This is a role-specific tool surface, not an OS sandbox; result writing remains guarded against candidate/parent mutation.

Verifier starts with requirements, diff and check results, batches source reads around concrete unresolved correctness questions, then writes its verdict. It must inspect actual assertions when needed, reject inadequate proof, and preserve defect and human-gate precedence. It does not reconstruct Executor history or design a competing implementation.

## Validation and consequences

A process-level adapter test checks fresh-session flags, ordinary versus adversarial effort and explicit command precedence. An opt-in live evaluator exercises a correct extraction, changed default, lost export, missing behavioral assertions and a falsy-value regression. It retains timing, results and failed attempts rather than treating process exit as correctness.

Reduced reasoning may miss subtle defects. Retain high-risk review intensity and measure negative cases alongside successful task latency. This policy does not promise a latency bound and does not make unsupported providers faster. Model variability requires repeated comparisons; an isolated fast run is insufficient to declare the broader performance goal complete.

## Supersedes

ADR-0008 clause 7's deferral of native review-effort changes after its custom-adapter pilot. Its evidence, isolation, recovery and high-risk unanimous-review requirements remain. Persistent shared sessions are rejected as a direction for this harness.
