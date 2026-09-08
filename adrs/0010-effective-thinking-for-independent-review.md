# ADR-0010: Match independent review effort to actual model capabilities

## Status

Accepted; supersedes ADR-0009's ordinary-review and bounded-execution medium requests.

## Context

Installed Pi 0.79.9 exposes only off, high and xhigh for the configured DeepSeek v4 Pro. Its clampThinkingLevel function rounds both low and medium up to high. Earlier experiments therefore compared identical effective reasoning levels; CLI argument tests established requested settings but did not establish provider behavior.

A bounded check-source preloading experiment passed deterministic and live quality tests but left the full extraction at 142 seconds, with a 78-second reviewer. It was removed rather than expanding evidence machinery without useful latency improvement.

An explicit off request produced a 21-second independent reviewer and a 97-second full extraction, versus the earlier 142-second loop and 79.5-second bare model baseline. All configured behavior checks passed. An expanded ten-case live evaluation accepted valid extractions/concurrency and found concrete export, behavior, mutation and concurrency defects, including the inadequate-proof case.

## Decision

Ordinary native Pi review requests off extended thinking and keeps its inspection/result-writing tool surface. This is still a separate fresh model session with full criteria, evidence, source inspection and an independent verdict. It does not bypass proof validation, gates or candidate/parent guards.

High-risk adversarial votes, planning and unhinted execution retain operator settings. Bounded first Direct execution also requests off. Existing admission excludes failed attempts and high-risk tasks; those retain configured effort. Explicit command templates remain operator-owned; Claude is unchanged. Add no model-selection matrix, extra agent role or provider SDK dependency.

Treat requested reasoning levels separately from effective capabilities in performance reports. Verify installed adapter/model mapping before interpreting effort comparisons. Never infer quality or speed from flag spelling alone.

Final native structured-contract runs completed in 64.9 and 82.5 seconds with two fresh sessions, no repair and passing typecheck/252-case checks. Small extraction took 44.0 seconds; a reproduced clamp bug fix took 33.7 seconds and passed 42 external oracle cases.

## Consequences and validation

Ten live quality cases include valid and broken concurrent deduplication and caller-array mutation. Negative cases must identify the expected defect in its source file; failing merely because tests are weak does not count. Keep negative findings and contract/process failures in benchmark results.

Off thinking can reduce quality on tasks outside this sample. High-risk review remains separate and unchanged. These measurements concern the configured backend, not every model accepted by Pi. Repeated native full/small runs and existing lifecycle tests establish the rollout evidence; neither a model's pass verdict nor the CLI test alone proves the performance objective.
