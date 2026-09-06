# Adaptive Agentic Loop Flow

```text
goal
  ↓
impact route
  ├─ bounded + concrete + 1-4 files → direct primary task
  └─ ambiguous/risky/pathless/gated → full planner
       ├─ unresolved human gate → needs_human
       └─ one primary + optional true prerequisite
       ↓
shared run worktree
       ↓
replan admission
  ├─ stale/manual/context drift/non-check failure → block stale task → planner
  └─ fresh task or check retry
       ↓
complexity
  ├─ high → stance reflection
  └─ low/medium → continue
       ↓
fresh executor: inspect, edit, validate, scoped docs
  ├─ direct needs_planner + clean diff → fresh full planner
  ├─ direct needs_planner + dirty diff → needs_human
  └─ completed → 1-3 targeted checks → scope rail
       ↓
verification profile
  ├─ low-risk bounded docs → skip
  ├─ normal → one verifier
  └─ high-risk → three adversarial votes
       ↓
pass → commit task → event/state/check/diff evidence → next task
       ↓
apply as unstaged diff, or retain with --no-apply
```

## Escalation map

| Evidence | Action |
| --- | --- |
| Goal ambiguity | Human question through planner verdict |
| Bounded concrete one-to-four-file goal | Direct Executor; no Planner |
| Stale planner revision | Replan |
| Goal, decision, assumption, question, or blocker drift | Replan |
| Understanding-sensitive failure | Replan |
| High complexity | Stance reflection |
| Failed checks | Retry |
| High verification risk | Adversarial verification |
| Required documentation | Executor completes within scope before verification |
| Candidate mutation or unresolved human gate | Stop before commit |

## Design rule

Planner owns understanding. Admission owns escalation. Protected invocation owns parent and reviewed-candidate integrity. Executor owns edits and scoped documentation. Checks and scope own deterministic proof. Verifier maps criteria to passed commands and independently judges sufficiency.

Soft targets: direct 60s, planned 180s, complex 300s. No forecast or latency-triggered Planner repair. Targets emit evidence but never kill phases or bypass safety rails. All model phases use fresh sessions; adversarial Verifier votes launch concurrently.

Deleted phases do not survive as compatibility fallbacks. Their responsibilities moved to owning modules.

Routine handover, progress, and final-summary Markdown are not part of the run. Pi logs contain compact operational summaries rather than repeated conversation history or tool payloads.
