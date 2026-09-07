# Coding Assistant Guardrails Project Map

## Purpose

Repository packages reusable agent skills, product-repo templates, and a TypeScript autonomous coding harness. Current development focus: `tools/agent-loop/`.

## Commands

Run from repository root unless noted.

```bash
# Typecheck
cd tools/agent-loop
npm exec -- tsc --noEmit

# Deterministic admission policy
cd ../..
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/phase-admission-smoke.ts

# Impact routing, Planner slicing, and latency policy
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/impact-routing-smoke.ts
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/planner-slice-contract-smoke.ts
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/latency-policy-smoke.ts
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/acceptance-proof-smoke.ts

# Structured checks and reviewer evidence
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/check-evidence-smoke.ts
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/review-evidence-smoke.ts

# Replay captured real model contract failures
AGENTIC_SMOKE_FILTER=captured ./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts

# Fresh native sessions and ordinary-review effort
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/fresh-session-smoke.ts

# Opt-in live reviewer quality/latency evaluation (real provider usage)
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/live-review-benchmark.ts --live

# Parent-checkout identity/content guard
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/checkout-integrity-smoke.ts

# Compact end-to-end behavior matrix
./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts

# One E2E case
AGENTIC_SMOKE_FILTER="planner from empty state" \
  ./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts

# CLI
cd tools/agent-loop
npm run agent -- init "goal"
npm run agent -- run --checks "npm exec -- tsc --noEmit"
```

Use targeted checks first. Full legacy PowerShell smokes are compatibility evidence, not default TypeScript validation.

## Public CLI

`run` intentionally exposes only operator-facing execution options:

- `--repo`
- `--command`
- `--agent-timeout`
- `--check-timeout`
- `--max-runtime-seconds`
- `--checks`
- `--worktree-bootstrap`
- `--worktree-bootstrap-ignore`
- `--check-env-file`
- `--allow-dirty`
- `--no-apply`

Policy owns planner mode, retries, phase admission, verification intensity, bootstrap defaults, human gates, and soft latency targets. `agentic.json.maxIterations` owns task-turn budget. `--max-runtime-seconds` remains a separate hard breaker.

## Architecture

| Path | Ownership |
| --- | --- |
| `tools/agent-loop/src/index.ts` | Small CLI: validate, init, diagnostics, run |
| `tools/agent-loop/src/loop/index.ts` | Deep run module: planner, replan, worktree, executor, checks, scope, verification, apply |
| `tools/agent-loop/src/loop/agent-phase.ts` | One protected agent-invocation interface for every model phase |
| `tools/agent-loop/src/admission/index.ts` | Deterministic replan, verification risk, and compact execution decisions |
| `tools/agent-loop/src/routing/index.ts` | Deterministic direct-vs-Planner impact route and direct-result contract |
| `tools/agent-loop/src/latency/index.ts` | Soft targets and measured phase overrun decisions |
| `tools/agent-loop/src/state/index.ts` | Canonical task/state types and transitions |
| `tools/agent-loop/src/context/index.ts` | Repository discovery; consumes canonical state |
| `tools/agent-loop/src/prompts/index.ts` | Private prompt implementation; exports only phase entry points and validators |
| `tools/agent-loop/src/agent/index.ts` | Real adapters for Pi, Claude, and custom commands |
| `tools/agent-loop/src/tools/index.ts` | Git worktrees and parent-checkout mutation guard |
| `tools/agent-loop/src/checks/index.ts` | Command resolution/provenance, shell syntax validation, candidate-bound check results, review evidence, metrics |
| `tools/agent-loop/src/scope/index.ts` | Scope matching, documentation facts, complexity escalation |
| `tools/agent-loop/src/events/index.ts` | Append-only lifecycle trace |
| `tools/agent-loop/src/reporting/index.ts` | Status, summary, failure, stuck diagnostics |

Canonical state types live only in `state/index.ts`. Context, scope, agent, prompts, and loop import them; no duplicate task schema exists.

## Run flow

1. Load policy and `agentic.json`; reject dirty parent checkout unless allowed.
2. If tasks are absent, deterministic impact routing selects:
   - bounded concrete goal naming one to four files → synthetic direct task;
   - ambiguous, risky, pathless, gated, or broader goal → full Planner.
3. Full Planner writes one primary implementation slice. One true prerequisite is allowed only with a dependency, distinct validation, and explicit split reason.
4. Create one shared run worktree.
5. Select next runnable task.
6. Replan admission:
   - fresh revision + no ambiguity → execute;
   - changed goal/decisions/assumptions/questions/blockers → invalidate plan and replan;
   - stale/manual task or non-check understanding failure → block stale task and replan;
   - check failure → retry directly.
7. Resolve complexity from declared uncertainty and protected behavior. File count and workflow label do not raise it. High complexity runs stance reflection.
8. Resolve operator/state/task checks before a fresh Executor session and show those same records in its prompt. Direct Executor returns a verdict and zero to three additional checks; zero is valid when configured checks suffice. Clean `needs_planner` escalates; dirty escalation stops.
9. Every agent phase protects parent HEAD/content. Verifier also guards candidate HEAD/content and records candidate identity. Any mutation stops before commit; any unresolved human gate stops regardless of vote count.
10. Parse proposed commands with the execution shell. Run targeted checks and record structured results bound to candidate HEAD/content. Check mutation invalidates evidence. Reviewers reference stable requirement/evidence IDs and distinguish behavioral, structural and documentation coverage; empty/diagnostic-only behavioral proof is rejected.
11. Enforce declared scope.
12. Resolve one verification profile:
    - bounded low-complexity documentation diff → skip verifier;
    - normal change → one verifier;
    - high risk → three adversarial votes.
13. Commit passed task inside run worktree. Events, phase logs, state snapshots, checks, diffs, and verifier JSON are canonical evidence; no routine handover, progress Markdown, or duplicate top-level run log is generated.
14. Executor completes required scoped documentation before checks and verification. No finalizer edits the verified result.
15. Apply run branch to parent checkout as unstaged changes unless `--no-apply`.
16. Record `lastRun` and `run_finished`/`run_latency` on success and handled failure. Stopped tasks cannot remain `running`. Abrupt process death is not covered by this finalizer; automatic resume is not implemented.

The live review evaluator accepts an optional `--command` template for controlled adapter comparisons. It records every result, contract failure, latency and retained fixture under `.agent-runs/live-review-*/`; its five extraction cases are a focused regression sample, not a general quality benchmark. See [measured performance and limits](docs/agentic-loop-performance.md).

By default every model phase starts a separate clean session; no conversation is resumed or handed from Executor to Verifier. Native Pi uses ephemeral sessions (`--no-session`) and medium reasoning for ordinary single review. A first bounded Direct Executor attempt also uses medium; planned execution, retries, Planner and high-risk adversarial votes retain the operator's configured effort. Explicit `--command` templates remain operator-owned, including session and effort settings; Claude effort is unchanged. Review starts from candidate evidence and batches source reads around unresolved correctness questions. Ordinary native Pi review enables read, grep, find, ls and write only: the harness owns shell checks, and the reviewer inspects assertions and writes its result. High-risk review and explicit command templates retain their tools. Candidate/parent guards still apply. It must still reject defects, inadequate behavioral proof and human gates.

Soft run targets are 60 seconds direct, 180 seconds planned, and 300 seconds complex. `phase_latency`, `run_latency`, and `latency_target_exceeded` expose measured durations and overruns. No predictive forecasts or latency-triggered Planner calls. Targets never terminate active work or bypass safety phases. High-risk reviewers run concurrently with distinct review focuses.

Bootstrap inherits policy unless overridden. It runs once per dependency fingerprint and reruns after dependency changes before checks. Fingerprint covers package manifests, common lockfiles/package-manager config, commands, Node version, platform and architecture. Bootstrap artifacts stay excluded from commits and scope checks.

Direct routing accepts up to 1000 characters. Mechanical extract/move/split/refactor goals require explicit behavior preservation. Short aliases resolve only to unique existing repository files. Bounded code uses compact context and existing focused validation; no fabricated red tests or incidental CodeGraph initialization.

Protocol errors use at most one fresh artifact-only repair per Direct/Verifier result. Parent and candidate guards apply; repair does not consume a code attempt or rerun implementation. Existing defects/gates are outcomes rather than repairable formatting. Code assertion failures retry within the task budget. Invalid configured checks, environment failure, and candidate mutation stop with evidence.

`check-evidence-smoke.ts` covers provenance/deduplication, syntax errors, partial results and candidate mutation. `review-evidence-smoke.ts` covers stable IDs, mixed evidence kinds and rejection of stale/missing evidence. `fixtures/live-contracts/` preserves real malformed model outputs; CLI replay requires repair without another executor and verifies terminal state.

`acceptance-proof-smoke.ts` tests rejection of vacuous commands. CLI smoke coverage includes runtime-preserving extraction with two invocations, candidate tampering, evidence-free review rejection, human-gate precedence, bootstrap reuse and dependency invalidation. These are deterministic adapter fixtures, not model quality or latency benchmarks.

## Deliberately removed ceremony

No standalone task-grill, decision-grill, post-task review, architect checkpoint, goal review, bundled preflight/review, finalize-docs, or finalizer verifier.

No deterministic `plan` command, per-task review branches, `accept`, `reset-task`, or `doctor`.

No merge-mode matrix, retry selector, verifier-vote override, fast-verifier flag, rebase-before-verify, phase-specific agent commands, or CLI planner-mode override.

## Preserved safety rails

- clean-parent gate
- single isolated run worktree
- identity/content parent mutation detection across planner, stance, executor, and verifier, including HEAD, untracked, already-dirty, and error-exit mutations
- task dependency ordering
- worktree bootstrap and ignored bootstrap artifacts
- targeted checks with env and timeout support
- hard scope enforcement
- deterministic complexity escalation
- semantic/path human gates
- adaptive verification with traceable risk/mode/votes
- retry and replan convergence budgets
- append-only events and failure analysis
- optional retain-without-apply handoff

## Validation coverage

`phase-admission-smoke.ts` covers:

- fresh vs stale replan admission
- direct check retry
- low/medium/high verification profiles
- catch-all and single-root recursive scope exclusion from low risk
- changed planning-context invalidation
- semantic human gates
- effective planner-mode precedence, source, and reason
- compact code admission without label/file-count escalation

`agent-log-smoke.ts` covers compact Pi telemetry, usage/turn preservation, content omission, and a bounded log size.

`agent-loop-ts-smoke.ts` covers:

- planning from an empty task graph
- direct documentation/code execution without Planner
- clean and dirty direct-to-Planner escalation
- direct-result retry
- full planning for ambiguous bounded goals
- slow history never adds Planner work
- low-risk documentation verifier skip
- scoped documentation checked and applied without finalization
- stale-task replan and replacement execution
- check retry without replan
- high-complexity stance plus adversarial verification
- scope violation
- parent checkout mutation from planner, stance, executor, and verifier
- dirty checkout rejection
- hard runtime breaker preservation and parallel adversarial vote launch

Focused policy smokes cover direct-route admission, coherent Planner slices, measured latency targets, and phase target decisions.

Pi JSON logs retain only session metadata, assistant/tool completion summaries, aggregate whole-invocation usage/cost, and bounded errors. Full message history, thinking, tool arguments, and tool results are intentionally omitted; use events, checks, diffs, result JSON, and failure analysis for run evidence. Compact tasks neither generate CodeGraph context nor initialize `.codegraph/`; existing indexes are synchronized when present.

`checkout-integrity-smoke.ts` covers parent HEAD movement without a file diff.

## Sources of truth

1. Current code and tests
2. This file
3. `CONTEXT.md`
4. Root `adrs/`
5. `docs/agentic-loop-reference.md`
6. Legacy PowerShell docs and smokes
