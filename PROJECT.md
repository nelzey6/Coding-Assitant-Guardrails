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

`run` intentionally exposes twelve options:

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
- `--no-finalize-docs`

Policy owns planner mode, retries, phase admission, verification intensity, bootstrap defaults, and human gates. `agentic.json.maxIterations` owns task-turn budget.

## Architecture

| Path | Ownership |
| --- | --- |
| `tools/agent-loop/src/index.ts` | Small CLI: validate, init, diagnostics, run |
| `tools/agent-loop/src/loop/index.ts` | Deep run module: planner, replan, worktree, executor, checks, scope, verification, apply |
| `tools/agent-loop/src/loop/agent-phase.ts` | One protected agent-invocation interface for every model phase |
| `tools/agent-loop/src/admission/index.ts` | Deterministic replan, verification-risk, and finalize-docs decisions |
| `tools/agent-loop/src/state/index.ts` | Canonical task/state types and transitions |
| `tools/agent-loop/src/context/index.ts` | Repository discovery; consumes canonical state |
| `tools/agent-loop/src/prompts/index.ts` | Private prompt implementation; exports only phase entry points and validators |
| `tools/agent-loop/src/agent/index.ts` | Real adapters for Pi, Claude, and custom commands |
| `tools/agent-loop/src/tools/index.ts` | Git worktrees and parent-checkout mutation guard |
| `tools/agent-loop/src/checks/index.ts` | Validation execution, env loading, timeout, metrics |
| `tools/agent-loop/src/scope/index.ts` | Scope matching, documentation facts, complexity escalation |
| `tools/agent-loop/src/events/index.ts` | Append-only lifecycle trace |
| `tools/agent-loop/src/reporting/index.ts` | Status, summary, failure, stuck diagnostics |

Canonical state types live only in `state/index.ts`. Context, scope, agent, prompts, and loop import them; no duplicate task schema exists.

## Run flow

1. Load policy and `agentic.json`; reject dirty parent checkout unless allowed.
2. If tasks are absent, Planner inspects goal/repo and writes one task graph plus grill transcript.
3. Create one shared run worktree.
4. Select next runnable task.
5. Replan admission:
   - fresh revision + no ambiguity → execute;
   - changed goal/decisions/assumptions/questions/blockers → invalidate plan and replan;
   - stale/manual task or non-check understanding failure → block stale task and replan;
   - check failure → retry directly.
6. Resolve complexity. High complexity runs stance reflection.
7. Every agent phase runs through one parent-checkout guard; agents may edit only their assigned worktree/artifact paths.
8. Run targeted checks.
9. Enforce declared scope.
10. Resolve one verification profile:
    - bounded low-complexity documentation diff → skip verifier;
    - normal change → one verifier;
    - high risk → three adversarial votes.
11. Commit passed task inside run worktree.
12. If durable docs changed, run one finalize-docs pass; reject non-documentation edits and commit accepted docs before apply.
13. Apply run branch to parent checkout as unstaged changes unless `--no-apply`.

## Deliberately removed ceremony

No standalone task-grill, decision-grill, post-task review, architect checkpoint, goal review, bundled preflight/review, or finalizer verifier.

No deterministic `plan` command, per-task review branches, `accept`, `reset-task`, or `doctor`.

No merge-mode matrix, retry selector, verifier-vote override, fast-verifier flag, rebase-before-verify, phase-specific agent commands, or CLI planner-mode override.

## Preserved safety rails

- clean-parent gate
- single isolated run worktree
- identity/content parent mutation detection across planner, stance, executor, verifier, and finalizer, including HEAD, untracked, already-dirty, and error-exit mutations
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
- finalize-docs admission

`agent-loop-ts-smoke.ts` covers:

- planning from an empty task graph
- low-risk documentation verifier skip
- finalize-docs commit/apply and non-documentation rejection
- stale-task replan and replacement execution
- check retry without replan
- high-complexity stance plus adversarial verification
- scope violation
- parent checkout mutation from planner, stance, executor, verifier, and finalizer
- dirty checkout rejection

`checkout-integrity-smoke.ts` covers parent HEAD movement without a file diff.

## Sources of truth

1. Current code and tests
2. This file
3. `CONTEXT.md`
4. Root `adrs/`
5. `docs/agentic-loop-reference.md`
6. Legacy PowerShell docs and smokes
