# Adaptive Agentic Loop Flow

```text
goal
  ↓
planner
  ├─ ambiguity or human gate → needs_human
  ├─ lite → task graph JSON only
  └─ full → task graph + decision transcript
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
executor → targeted checks → scope rail
       ↓
verification profile
  ├─ low-risk bounded docs → skip
  ├─ normal → one verifier
  └─ high-risk → three adversarial votes
       ↓
pass → commit task → event/state/check/diff evidence → next task
       ↓
source-of-truth docs changed? → one docs-only finalize pass → commit
       ↓
apply as unstaged diff, or retain with --no-apply
```

## Escalation map

| Evidence | Action |
| --- | --- |
| Goal ambiguity | Human question through planner verdict |
| Stale planner revision | Replan |
| Goal, decision, assumption, question, or blocker drift | Replan |
| Understanding-sensitive failure | Replan |
| High complexity | Stance reflection |
| Failed checks | Retry |
| High verification risk | Adversarial verification |
| Source-of-truth docs changed | Finalize docs |

## Design rule

Planner owns understanding. Admission owns escalation. Protected invocation owns parent-checkout integrity. Executor owns edits. Checks and scope own deterministic proof. Verifier owns independent judgment.

Deleted phases do not survive as compatibility fallbacks. Their responsibilities moved to owning modules.

Routine handover, progress, and final-summary Markdown are not part of the run. Pi logs contain compact operational summaries rather than repeated conversation history or tool payloads.
