# Agentic loop production-hardening: scope rails, risk-gated verification, budgets

The agentic loop harness (`scripts/agentic/agentic-loop.ps1`) separates deterministic
rails (worktrees, git, state, merge) from LLM reasoning (plan, execute, verify). The
original design left three safety properties to the LLM verifier alone: diff scope,
fast-verifier risk, and verification confidence. A dogfood review found these were
"vibes, not rails" — the verifier is a single same-model vote, `--fast-verifier` made
the executor's own test the entire gate, and nothing bounded a runaway run. This ADR
records the decisions that move those properties into the deterministic layer.

## Decisions

### 1. Task scope is planner-authored globs, enforced as a pre-verifier rail

Each task may carry an optional `scope` glob list (e.g. `["scripts/agentic/**"]`). When
present, the harness checks `git diff --name-only HEAD` after the executor and **before**
the verifier; any changed file outside scope is a **retryable** failure with the offending
paths fed into the retry prompt. When `scope` is absent the check is advisory (logged, not
blocking) so existing state files keep working.

- **Baseline is `HEAD`, not merge-base** — the check runs pre-commit, so `HEAD` is exactly
  this attempt's delta and matches the existing diff artifacts. Merge-base would only matter
  if the harness committed mid-task before checking, which it does not.
- **Pre-verifier, retryable** — a scope violation can never reach merge even if the LLM
  verifier would miss it, and a single stray file gets a precise correction instead of a
  dead-end.

### 2. `--fast-verifier` is gated on declared risk, not trusted blindly

Fast-verifier (skip the separate verifier agent after checks pass) is permitted **only** when
the task is `kind ∈ {maintenance, discovery, investigation}` AND declares a `scope`. Any
`implementation`/`architecture` task, or any task without scope, forces the full verifier and
emits a `verifier_skip_denied` event. The deterministic layer cannot semantically match prose
human-gates like "billing logic", so it trusts the validated `kind` classification and requires
item 1's scope rail to be active as defense in depth. Prose gate-matching stays in the LLM
verifier prompt where it belongs.

### 3. Planner output has a task-complexity budget

`Test-PlannerResult` rejects tasks that are too broad to verify: more than 7 acceptance
criteria, more than 5 scope globs, or empty `acceptanceCriteria` on an implementation/
architecture task. Over-budget tasks must be split or recorded as `openQuestions`/`needs_human`.
This makes the "keep tasks small" guidance an enforced constraint, not a prompt suggestion.

### 4. Global circuit-breaker bounds runaway runs

`--max-runtime-seconds` (wall-clock across the whole run) and `--max-agent-calls`
(planner+executor+verifier invocations) stop the loop cleanly with a `budget_exhausted` event
and `needs_human` handoff. Token metering is deliberately omitted: the harness cannot observe
Bedrock token counts, so wall-clock + call-count is the honest proxy rather than a fake number.

### 5. Shell invocation avoids string interpolation

`Invoke-ShellCommandCapture` passes commands via argument arrays / stdin instead of
interpolating into `-Command "<string>"`, closing the arbitrary-execution surface for any
validation string that originates from planner output rather than the operator.

### 6. Verification is adversarial and risk-gated

Verification defaults to a single verifier. For high-risk tasks (`kind:
implementation|architecture`, or a scope matching a human-gate path glob), the harness spawns
N verifier calls (default 3) **prompted to refute** the change and requires a majority `pass`.
`--verifier-votes <n>` overrides the count. This closes the single-same-model-vote hole for
exactly the tasks where a plausible-but-wrong diff is most dangerous, without paying the cost
on every low-risk task.

## Tradeoffs

- **`kind` is self-declared by the planner.** A mis-classified task could under-trigger the
  risk gates. Mitigated by: the complexity budget (item 3) constraining what a task can claim,
  and scope being required for any fast-path. We accept planner trust here because the planner
  already runs grill-with-docs discovery and its output is validated.
- **Scope is advisory when absent.** This preserves backward compatibility at the cost of no
  enforcement on legacy tasks. The planner prompt is updated to always emit scope, so new tasks
  are always guarded; only hand-written/old state files degrade to advisory.
- **No token budget.** Wall-clock and call-count are coarser than tokens but observable;
  a fabricated token estimate would be worse than an honest proxy.
