# Agentic Loop — Current Workflow

The loop turns a goal into scoped tasks and uses fresh agents to challenge readiness, technical approach, correctness, and remaining-plan validity.

## Workflow

```text
GOAL
  │
  ▼
[1. DISCOVERY]
Skill: grill-with-docs
Question: What should be built?
Output: clarified goal, decisions, acceptance criteria
State: discovery → planning
  │
  ▼
[2. PLANNING]
Agent: planner
Uses: workflow policy + repository evidence
Output:
- tasks and dependencies
- complexity: low | medium | high
- complexity reasons
- reflection checkpoint metadata
State: planning → execution
  │
  ▼
[3. TASK READINESS]
Phase: task-grill
Question: Is the next task still valid, scoped, and safe?
Verdicts: ready | needs_replan | needs_human | blocked
  │
  ▼
[4. APPROACH REFLECTION] — high-complexity tasks only
Skill: reflect-on-approach, stance mode
Question: Is this implementation approach actually good?
Runs: 2–3 fresh-context refinement rounds in a clean worktree
Verdicts: reconfirm | readjust | reassess | needs_human
Output: approved implementation stance
  │
  ▼
[5. IMPLEMENTATION]
Skill: tdd | diagnose | improve-codebase-architecture | zoom-out | etc.
State: task running
  │
  ├── planned milestone reached
  │       ▼
  │   [6. CHECKPOINT REFLECTION — PLANNED]
  │   Skill: reflect-on-approach, checkpoint mode
  │   Verdicts: continue | adjust | needs_plan_review | needs_human
  │   Note: metadata exists; execution requires a future resumable executor lifecycle.
  │
  ▼
[7. VERIFICATION]
Agent: verifier
Question: Was the task implemented correctly?
Uses: acceptance criteria, checks, diff/scope, human gates
Verdicts: pass | fail | needs_human
  │
  ▼
[8. PLAN REFLECTION]
Skill: reflect-on-approach, plan mode
Current trigger: after every passed task unless disabled
Question: Is the remaining plan still correct?
Verdicts: continue | adjust_remaining_tasks | replan | needs_human
  │
  ├── adjust/replan → block stale pending tasks → planner creates replacements
  └── continue → select next task
  ▼
[9. GOAL REVIEW]
Optional final cumulative review
Question: Does completed work satisfy the original goal?
State: complete | needs_human
```

## Responsibility boundaries

| Phase | Owns | Does not own |
| --- | --- | --- |
| `grill-with-docs` | Goal, requirements, terminology, acceptance criteria | Technical implementation stance |
| Planner | Task graph, scope, workflow, complexity, checkpoint metadata | Execution |
| Task-grill | Current readiness, scope, safety, stale assumptions | Architecture refinement |
| Stance reflection | Iterative technical approach refinement | Requirements or file edits |
| Workflow executor | One approved task | Status, merge, plan mutation |
| Verifier | Correctness, checks, scope, human gates | Choosing a new approach |
| Plan reflection | Remaining-plan validity | Direct task mutation |
| Harness | State, retries, replans, worktrees, apply/merge | Open-ended reasoning |

## Complexity and reflection

The planner proposes `complexity`, `complexityReasons`, and optional `reflectionCheckpoints`. The harness may escalate complexity but never lower the proposal. Architecture work, broad scope, multiple dependencies, and high-risk scope can force `high`.

Before a high-complexity executor runs, fresh stance agents challenge ownership, seams, assumptions, reversibility, sequence, expected edits, and validation. The harness requires evidence, rejects worktree edits, persists `approved-stance.json`, and injects it into the executor prompt.

Post-task plan reflection runs after every passed task by default. `adjust_remaining_tasks` and `replan` block stale pending tasks and invoke the planner. Completed tasks remain historical facts.

## Implemented versus planned

- Implemented: complexity resolution, 2–3 pre-edit stance rounds, approved stance injection, plan-mode post-task review.
- Planned: fresh-agent reflection at implementation milestones. Metadata exists, but the executor is not yet resumable.
- Compatibility: periodic architect checkpointing remains available but defaults off.

## Main artifacts

| Artifact | Purpose |
| --- | --- |
| `agentic.json` | Goal, task graph, complexity, assumptions, and statuses |
| `.agent-runs/events.jsonl` | Lifecycle audit log |
| `grill-transcript.md` | Discovery evidence and decisions |
| `task-grill-result.json` | Readiness verdict |
| `stance-reflection-<n>.json` | Iterative stance review |
| `approved-stance.json` | Stance injected into executor |
| `checks.log` / `diff.patch` | Validation and changed code |
| `verifier-result.json` | Correctness verdict |
| `post-task-review-result.json` | Remaining-plan verdict |

## Related documentation

- [Root README](../README.md)
- [Agentic loop reference](./agentic-loop-reference.md)
- [PROJECT.md](../PROJECT.md)
- [reflect-on-approach skill](../skills/engineering/reflect-on-approach/SKILL.md)
- [ADR-0003](../adrs/0003-complexity-gated-approach-reflection.md)
