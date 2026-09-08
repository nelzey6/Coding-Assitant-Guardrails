# Fresh-session performance assessment — 2026-09-08

Native Pi 0.79.9, DeepSeek v4 Pro. All live model invocations ran sequentially. Each executor and reviewer used a separate fresh session. Operator defaults remain DeepSeek v4 Pro/xhigh; only native bounded first execution and ordinary review request off extended thinking. Explicit command templates and Claude remain unchanged.

## Findings and final architecture

The measured cost was model work and avoidable artifact repair, not TypeScript orchestration. Installed Pi exposes only off, high and xhigh for this model; its clampThinkingLevel rounds both low and medium upward to high. Earlier labels therefore described requested flags, not distinct effective effort levels.

The normal bounded code path is one fresh Executor, deterministic checks, then one fresh independent Verifier. No shared conversation, routine Planner, finalizer, extra architecture agent or duplicate review. Existing risk admission preserves Planner for ambiguous work, stance and three independent adversarial votes for high risk, configured thinking for planned execution and retries, scope enforcement, candidate/parent guards, human gates and bounded recovery.

Ordinary review inspects source and assertions with read/search tools and writes a verdict. The harness owns shell checks. Candidate evidence carries continuity across sessions. Review judges semantic adequacy; a green command or a valid JSON shape is not automatically correctness.

Two real protocol failures informed simpler contracts:

- Executor reports mixed prose into validation command strings, causing a 29.4-second repair. New additionalChecks objects separate command from optional reason; reports belong in summary. Configured checks remain mandatory. Legacy arrays remain readable, and executable text is never silently sanitized.
- Correct documentation coverage cited a typecheck instead of the diff, causing a 31.7-second repair. Documentation now always binds to the candidate diff. The independent reviewer still decides whether it is correct; behavioral and structural references remain explicit.

## Full repository extraction

Extract parseMetricLines, private constants and MetricMap; preserve exports and behavior; update PROJECT.md. Every successful run below passed TypeScript and an external 252-case equivalence oracle. Total wall time includes startup/bootstrap/checks/review/commit. Snapshots evolve, so these are observations rather than a controlled statistical speedup estimate.

| Configuration | Executor | Review | Extra repair | Total |
|---|---:|---:|---:|---:|
| Earlier native xhigh | ~68.5s | ~125s | none | 196.8s |
| Requested medium (effectively high), inspection-only review | 69.7s | 69.5s | none | 142.5s |
| Source-preload experiment, rejected | 61.3s | 77.7s | none | 142.3s |
| High executor, off review pilot | 73.3s | 20.7s | none | 96.6s |
| Native high executor, off review | 88.5s | 24.1s | none | 117.0s |
| Native high executor, wrong documentation reference | 103.9s | 29.6s | 31.7s | 168.7s |
| Native high executor, deterministic documentation binding | 67.5s | 47.8s | none | 118.8s |
| Both off pilot | 48.1s | 31.4s | none | 82.3s |
| Native both off, ambiguous validation report | 48.3s | 31.9s | 29.4s | 113.0s |
| Native final structured contract | 38.0s | 23.5s | none | 64.9s |
| Native final repeat | 50.9s | 28.2s | none | 82.5s |

Earlier guarded single-executor baseline: 79.5 seconds plus ~1.3 seconds bootstrap, without independent review. Final observations of 64.9 and 82.5 seconds reach that latency class while retaining two sessions; they do not prove every run will beat a single executor. Both exceed the existing 60-second soft Direct target. No target was relaxed to declare a faster result.

## Other actual tasks

- Small JavaScript extraction: 44.0 seconds, passed 11 Node tests. Independent external verification passed 252 comparisons, identical function re-export, verbatim extraction and unchanged formatting. Earlier requested-medium path took 48.2 seconds; high-executor/off-review took 46.4 seconds.
- Finite-number clamp bug fix: 33.7 seconds, from a reproduced failing baseline to five passing tests plus 42 external oracle cases. Earlier high-executor/off-review took 42.6 seconds.

These are actual code edits followed by independent fresh reviews, not mocked latency measurements.

## Reviewer quality

Native Pro/off passed eight cases covering valid extraction, changed default, lost export, absent behavioral assertions, falsy values, caller-array mutation, correct concurrent-load deduplication and broken concurrent loading. A subsequent two-case run accepted updated documentation and rejected stale documentation despite passing code checks. All ten expected outcomes were correct. Negative cases require a concrete finding in the relevant file, not just a generic fail for weak tests.

Earlier five-case observations: requested medium with shell 5/5, median 58.5 seconds; requested low with shorter prompts 5/5, median 51.4 seconds; inspection-only requested medium 5/5, median 37.7 seconds; Pro/off 5/5, median 20.1 seconds. Low/medium both resolved to high, and prompt/tool changes prevent attributing all timing differences to thinking alone.

An explicit Flash/off comparison passed ten cases but did not justify a model-routing matrix or changing the operator's default model. A source-preloading implementation also passed checks but did not improve the full benchmark, so it was removed. Neither experiment remains in production.

## Validation and limits

TypeScript, structured Direct contract, fresh-session adapter, reviewer evidence, routing, acceptance proof and phase-admission checks pass. All 39 CLI cases pass, including actual structured command execution, legacy artifact repair, two-call extraction, planner escalation, retries, bootstrap reuse, high-risk stance/votes, unresolved defect/gate precedence, scope and checkout mutation guards, and hard time limits.

This establishes substantially lower observed latency on extraction and a bounded bug fix, while preserving tested lifecycle capabilities and independently detecting the seeded defects. It is not a universal quality guarantee or latency SLA. High-risk and planned tasks deliberately retain more work. Provider variability remains material; slow and repaired runs above are part of the result. Windows and Claude performance were not benchmarked.

Run the opt-in ten-case quality evaluation (real provider usage):

```sh
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/live-review-benchmark.ts --live
```

Optional --command accepts the normal prompt-placeholder template for explicit comparisons. Keep live runs sequential. Local raw evidence is under .agent-runs/20260907-bounded-off/, .agent-runs/20260907-review-off/, and the timestamped live-review directories. These scratch artifacts are deliberately not committed.
