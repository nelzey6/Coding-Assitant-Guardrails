# Agentic loop harness

Two ways to run the agentic loop — pick the one that fits your context.

---

## Option A — Inside Claude Code (you are already in a conversation)

Just invoke the skill. No terminal, no subprocess:

```
/agentic-loop <your goal>
```

Claude plans the goal, then executes each task directly in the conversation (task-grill → execute → checks → verify), printing progress after each task. All artifacts go to `.agent-runs/`.

---

## Option B — From a terminal (fresh agent per task)

The harness spawns a new `pi` process for each executor and verifier call. `pi` is the default.

```powershell
# Plan first, review agentic.json, then run
agentic-loop run --plan-only --goal "Fix checkout reliability" --checks "npm test"
agentic-loop run --checks "npm test"

# Or just run — planner fires automatically if agentic.json has no tasks
agentic-loop run --checks "npm test"

# Use claude instead of pi
agentic-loop run --tool claude --checks "npm test"

# Hold task branches for human review instead of auto-merging
agentic-loop run --no-merge --checks "npm test"
agentic-loop accept task-001
```

Use `pwsh -File scripts/agentic/agentic-loop.ps1` if the `agentic-loop` shim is not installed yet.

---

## Diagnostics (always safe to run, even with dirty working tree)

```powershell
agentic-loop status        # task list and what's next
agentic-loop why-stuck     # explain blocked or needs_human tasks
agentic-loop last-failure  # most recent failure details
agentic-loop summary       # compact checkpoint overview
agentic-loop doctor        # check for stale branches/worktrees
```

To clean up a stuck task and retry it:

```powershell
agentic-loop reset-task <task-id> --apply
agentic-loop run
```

---

## Minimal `agentic.json`

The planner writes this automatically. If you prefer to seed it yourself:

```json
{
  "version": 1,
  "goal": "Fix checkout reliability",
  "maxIterations": 3,
  "checks": ["npm test"],
  "tasks": [
    {
      "id": "task-001",
      "title": "Reproduce and fix retry failure",
      "status": "pending",
      "workflow": "diagnose",
      "priority": 1,
      "acceptanceCriteria": [],
      "validation": [],
      "dependsOn": []
    }
  ],
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "promptPolicy": { "lessons": [] }
}
```

---

## More detail

| Topic | Where |
| --- | --- |
| All flags, review flows, retry, rails, metrics | [docs/agentic-loop-reference.md](../../docs/agentic-loop-reference.md) |
| Visual phase diagram | [docs/agentic-loop-flow.md](../../docs/agentic-loop-flow.md) |
| TS architecture, module map, gaps | [PROJECT.md](../../PROJECT.md) |
