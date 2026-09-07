# Coding Assistant Guardrails — Domain Language

Canonical terms for code, docs, prompts, and issues.

## Harness and lifecycle

**Agentic loop** (or **harness**):
TypeScript CLI under `tools/agent-loop/` that turns one goal into isolated, checked repository changes.

**Goal**:
Plain-English outcome stored in `agentic.json`. Created with `agent init "<goal>"`.

**Run**:
One `agent run` invocation. It plans when necessary, executes runnable tasks, escalates only from evidence, and either applies changes or stops with traceable state.

**Fresh session**:
Independent model invocation with no prior role conversation. Goal, scoped task and candidate evidence provide continuity; conversation history does not. Executor and Verifier remain separate sessions.

**Run worktree**:
Single isolated worktree at `.worktrees/run-<timestamp>/` on `agentic/run-<timestamp>`. All task commits stay there until completion.

**Apply**:
Default completion behavior. Harness copies run-branch files into parent checkout as unstaged changes, then removes run worktree and branch. `--no-apply` retains them.

**Task**:
Verification slice with id, title, workflow, acceptance criteria, scope, validation commands, dependencies, complexity, and status.

**Task status**:
`pending`, `running`, `passed`, `failed`, `needs_retry`, `needs_human`, or `blocked`.

## Adaptive phases

**Planner**:
Owns understanding, questions, decisions, assumptions, task slicing, scope, and validation design. Fresh planner revisions authorize execution.

**Impact route**:
Deterministic first decision for an empty goal. A bounded concrete goal naming one to four files becomes one Direct task; ambiguity, risk, missing paths, or human gates enter full Planner.

**Direct task**:
Synthetic low-complexity primary task whose acceptance criterion is Goal and whose scope is exactly the named files.

**Direct execution result**:
Executor JSON verdict: `completed`, `needs_planner`, or `needs_human`, with summary, assumptions, and zero to three additional executable validation commands. Existing configured checks may satisfy completion without additions.

**Primary slice**:
Single coherent implementation unit produced by full Planner. It owns goal delivery and main acceptance proof.

**Prerequisite slice**:
Optional single task required by Primary slice. Valid only with a real dependency, distinct validation, and explicit split reason.

**Soft latency target**:
Traceable performance objective, not cancellation. Direct targets 60 seconds, planned 180 seconds, complex 300 seconds; phase targets annotate measured durations; no forecasts or latency-triggered phases.

**Replan admission**:
Deterministic check before execution. Stale/manual tasks, changed planning context, unresolved ambiguity, and understanding-sensitive failures return to Planner. Check failures retry directly.

**Planning context fingerprint**:
Stable identity of goal, decisions, assumptions, open questions, and blockers when Planner authorizes a task. Drift invalidates that task before Executor starts.

**Stance reflection**:
One pre-edit self-challenge for high-complexity tasks. Produces an approved technical stance or stops for human input.

**Executor**:
Owns task inspection, edits, local validation and required scoped documentation inside Run worktree.

**Checks**:
Deterministic validation commands resolved before execution from operator, state and task, with provenance, working directory, identity and candidate-bound results.

**Scope rail**:
Compares changed files with task scope. Out-of-scope changes fail before verification.

**Verification profile**:
Single risk decision from task complexity, meaningful scope, actual changed paths, failures, architecture intent, path gates, and semantic human gates.

**Verifier**:
Independent review after checks. Low-risk bounded documentation changes skip it; normal changes use one vote; high-risk changes use three adversarial votes.

**Acceptance proof**:
Coverage mapping stable requirement IDs to candidate-bound evidence IDs. Behavioral claims require passed assertion checks; structure and documentation can reference the diff with appropriate inspection. Verifier judges relevance and compound-requirement coverage; diagnostic-only commands are insufficient for behavior.

**Candidate guard**:
Content/HEAD snapshots around Verifier invocation detect mutation of the checked worktree and stop before commit. Review artifacts live outside that worktree.

**Parent checkout guard**:
One protected invocation seam around every model phase. It detects parent HEAD or content changes, records evidence, and stops without restoring or hiding mutations.

## Escalation rules

- Ambiguity → Planner returns `needs_human`
- Bounded concrete one-to-four-file goal → Direct task
- Stale revision or changed planning context → replan
- High complexity from concrete uncertainty/impact → stance reflection
- Invalid model result or proposed command → one guarded artifact repair
- Real code assertion failure → bounded code retry
- Invalid configured command, environment failure or candidate mutation → stop with evidence
- Changed assumptions or understanding-sensitive failure → replan
- High risk → adversarial verification
- Required documentation → scoped Executor work before checks
- Candidate mutation or unresolved human gate → stop before commit

## Key artifacts

- `agentic.json` — goal, task graph, decisions, assumptions, statuses
- `grill-transcript.md` — full-Planner evidence and resolved goal decisions; omitted in Planner-lite
- `executor.md` / `executor.log` — execution contract and output
- `checks.log` — formatted deterministic validation output
- `check-evidence.json` — structured per-check outcomes and candidate identity
- `review-evidence.json` — stable requirement references, passed checks and diff identity
- `lastRun` in agentic.json — terminal outcome, failed stage, retained worktree and elapsed time
- `verifier-result.json` — verification verdict when admitted
- `approved-stance.json` — high-complexity stance
- `failure-analysis.json` — failed phase, reason, attempt, diff stat
- `.agent-runs/events.jsonl` — append-only trace
- `direct-execution-result.json` — Direct Executor verdict, checks, and assumptions

Routine handover, progress, and final-summary Markdown are intentionally omitted. State, events, checks, diffs, and phase result JSON own traceability.

## Relationships

- Goal has one impact route and one task graph.
- Direct route bypasses Planner but not checks, scope, verification, commit, or apply.
- Planner owns understanding; no parallel task-grill contract exists.
- Run processes tasks in one Run worktree.
- Each fresh task follows: replan admission → optional stance → Executor → Checks → Scope rail → adaptive Verifier.
- Every model phase crosses Parent checkout guard; only Executor may edit candidate repository files; bootstrap owns its declared artifacts.
- Failure evidence flows into retries or Planner.
