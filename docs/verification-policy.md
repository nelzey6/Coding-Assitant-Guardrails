# Verification Policy

Verification is evidence-driven. The default check is the smallest reliable
check that proves the changed behavior, not the largest available suite.

## Selection order

1. Read `git diff --name-only` and the task acceptance criteria.
2. Identify the owning module, public seam, and directly affected callers.
3. Choose one focused check for the changed behavior.
4. Add one adjacent integration/smoke check only when the change crosses a
   process, CLI, worktree, persistence, or agent-phase boundary.
5. Broaden to a package or full suite only when impact evidence justifies it.

## Verification tiers

| Change shape | Default proof | Broaden only when |
| --- | --- | --- |
| Markdown/docs/policy only | diff check, link/JSON parse, relevant validator | generated docs, templates, or consumers are affected |
| Pure helper or admission rule | focused unit/smoke assertion | callers or type contracts changed |
| One loop phase or prompt contract | focused phase smoke + typecheck | phase ordering/state persistence also changed |
| CLI wiring or transport seam | one filtered end-to-end smoke + typecheck | multiple transports/process boundaries changed |
| Cross-module/public behavior | focused regression + affected integration check | dependency graph or risk evidence requires package/full suite |

## Smoke-suite rule

Never run `all-smoke.ps1` or the complete `agent-loop-ts-smoke.ts` as the
automatic response to a small change. Use the test's filter or the smallest
individual smoke that covers the changed seam, for example:

```bash
AGENTIC_SMOKE_FILTER="planner from empty state" \
  ./tools/agent-loop/node_modules/.bin/tsx tests/agentic/agent-loop-ts-smoke.ts
```

Run the full suite only when at least one of these is true:

- a shared state schema or public CLI contract changed;
- orchestration/order, worktree, transport, or process lifecycle changed;
- affected callers cannot be identified confidently;
- the change is release/merge-critical;
- a focused check passes but broader evidence is needed to investigate a
  failure or regression.

Record the reason whenever broad validation is selected. If a broad suite is
slow, flaky, or infrastructure-blocked, keep the focused evidence and report
the residual coverage gap; do not repeatedly rerun it without new evidence.

## Handoff requirement

Report validation as a mapping:

```text
changed seam → command → result → remaining risk
```

Do not claim full confidence from a broad suite that did not complete. Separate
code failures from harness, environment, dependency, and test-fixture failures.
