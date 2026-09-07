# Fresh-session performance assessment — 2026-09-07

Native Pi, DeepSeek v4 Pro. Local configured effort xhigh. All live invocations ran sequentially. Every reviewed candidate used a distinct session from its executor. Default changes apply to native Pi; custom commands retain control and Claude behavior is unchanged.

## Changes tested

- Explicit ephemeral native sessions; no conversation reuse.
- Medium reasoning for ordinary review and bounded Direct first attempts. Existing compact admission excludes high risk and failed attempts.
- Concise, grouped evidence coverage instead of repeated requirement essays.
- Ordinary native review uses read/search and result-writing tools; deterministic shell execution belongs to the harness. High-risk review retains its tools and configured effort.
- Same candidate-bound checks, scope, mutation guards, gates, independent votes and bounded recovery.

## Full repository extraction

Same metric parser extraction goal, typecheck and external 252-case behavior comparison. Wall time includes startup/bootstrap/checks/review/commit. Snapshots differ as the harness evolves; these are observations, not a controlled statistical speedup estimate.

| Configuration | Executor | Review | Total | Outcome |
|---|---:|---:|---:|---|
| Earlier native xhigh baseline | ~68.5s | ~125s | 196.8s | Passed |
| Medium review, original executor effort | 83.2s | 64.6s | 151.2s | Passed |
| Medium bounded executor and review, shell still available | 75.0s | 113.6s | 191.8s | Passed |
| Final inspection-only review | 69.7s | 69.5s | 142.5s | Passed |

The 191.8s run is material: reasoning changes alone did not reliably improve latency. Its reviewer launched repeated shell commands and encountered a tool error. The final architecture removes shell experimentation from ordinary review rather than adding another prompt-only warning.

Earlier guarded single-executor baseline: 79.5s model invocation, plus ~1.3s bootstrap; no independent review. This is useful context, not equivalent verification coverage.

## Small fixture

Final native path: 48.2s total, 20.6s Executor, 26.2s Verifier, 0.2s checks. Passed 11 existing Node tests and an external 252-case equivalence oracle. The oracle additionally checks verbatim extraction, identical function re-export and unchanged formatting. Earlier three xhigh trials took 79.9s/58.0s/58.4s; the middle run failed its old proof protocol despite correct code.

## Reviewer quality evaluation

Five cases: correct extraction, changed default, lost export, absent behavioral assertions, falsy-value regression. Expected one pass and four failures. The evaluator records contract errors and process failures too.

Medium with shell: 5/5, median 58.5s. Low with shorter response instructions: 5/5, median 51.4s, one case 71.0s. Low effort was not adopted: the modest, variable gain does not justify another default change. Prompt and effort changed together, so these runs do not isolate the effect of effort.

Final inspection-only evaluation: **5/5**, median **37.7s** (range 28.6–52.5s). No artifact repairs were needed. Both acceptance of the valid candidate and rejection of all four negative cases were checked.

These extraction fixtures establish targeted regression coverage. They do not establish general coding quality, a fixed latency bound, or behavior on other providers. All benchmark failures and slow runs remain part of the evidence.

## Validation and limits

TypeScript compilation, the fresh-session process test, review-evidence and phase-admission checks, all 39 CLI smoke cases, and 28-skill validation passed. Native session/tool behavior was exercised on macOS; Windows and Claude performance were not benchmarked.

The final full run used two model invocations with no artifact repair or code retry. Its roughly three seconds of harness work is already small compared with 139 seconds in models. The broader near-single-agent-runtime goal remains unmet on this larger fixture: its earlier guarded bare-model baseline was about 79.5 seconds. Further changes must reduce model work or serving latency; moving TypeScript modules around will not remove that measured cost.

Re-run the focused live quality sample from repository root:

```sh
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/live-review-benchmark.ts --live
```

The evaluator's optional `--command` accepts the same prompt-placeholder convention as the harness for explicit model/effort comparisons. Keep runs sequential when comparing latency. Inspect concrete findings as well as its pass/fail score; five small cases do not establish universal reviewer quality.
