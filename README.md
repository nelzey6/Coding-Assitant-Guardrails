# Autonomous Coding Loop

An autonomous agent harness that takes a goal, plans it into tasks, self-reviews each one before touching code, executes in isolated git worktrees, and verifies the result — all without human intervention per task.

Built for [Codex](https://openai.com/codex), [Claude Code](https://claude.ai/code), and compatible CLI agents (`pi`, `claude`, custom).

```
/agentic-loop Refactor the auth module to use the new token store
```

That's it. The loop plans, grills itself, executes, checks, and merges — or tells you exactly why it stopped.

---

## How it works

Each run goes through five phases per task:

1. **Plan** — a planner agent reads the goal, runs a full `grill-with-docs` self-interview, and produces a task graph with acceptance criteria, scope globs, and validation commands.
2. **Task-grill** — before the executor touches anything, a reviewer agent asks 15+ structured questions about scope, assumptions, risks, and design choices — and answers them from repo evidence.
3. **Execute** — a fresh agent spawns in an isolated git worktree (`.worktrees/<task-id>/`) and works the task using the selected workflow skill (`tdd`, `diagnose`, `zoom-out`, etc.).
4. **Verify** — a separate verifier agent reviews the diff, check output, and acceptance criteria, returning `pass`, `fail`, or `needs_human`.
5. **Merge** — passed tasks merge back to main. Failed tasks are retried with a failure-analysis artifact so the next attempt knows what went wrong.

The main branch stays clean throughout. State persists in `agentic.json` so runs survive interruption and resume where they left off.

---

## Quickstart

### Option A — Inside Claude Code (conversational)

```
/agentic-loop <your goal>
```

Claude plans the goal and works through each task in the conversation, printing progress after each one. No terminal needed.

### Option B — Terminal (fully unattended, fresh agent per task)

Install into your product repo first:

```powershell
# Windows
.\scripts\bootstrap\setup-ai-skills.ps1 -Destination D:\Repos\MyProduct
```

```bash
# macOS / Linux
./scripts/bootstrap/setup-ai-skills.sh --destination "$HOME/src/my-product"
```

Then from your product repo:

```powershell
agentic-loop run --checks "npm test"
```

`pi` is the default executor. Each task gets a brand-new process — no shared context, no accumulated mistakes across tasks.

```powershell
agentic-loop run --tool claude --checks "npm test"   # use Claude instead
agentic-loop run --plan-only                          # plan, review agentic.json, then run
agentic-loop run                                      # resume from existing plan
```

---

## Safety rails

The loop is designed to fail loudly rather than silently produce wrong output:

- **Scope enforcement** — each task declares a glob list of files it may touch. Changes outside scope fail the task before the verifier runs.
- **Task-grill gate** — execution is blocked if the pre-flight reviewer returns `needs_replan`, `needs_human`, or `blocked`.
- **Decision-grill** — design decisions are weighed with 2–4 evidenced options before the executor acts. Shallow decisions are rejected by the harness.
- **Failure analysis** — every failure writes a structured `failure-analysis.json` so retry attempts don't repeat the same mistake.
- **Architect checkpoint** — after every N passed tasks the remaining plan is reviewed for drift before continuing.
- **Goal review** — at the end the cumulative diff is judged against the original goal; gaps surface as `needs_human`.

---

## Diagnostics

```powershell
agentic-loop status                    # task list and what's next
agentic-loop why-stuck                 # explain blocked or needs_human tasks
agentic-loop last-failure              # most recent failure details
agentic-loop reset-task <id> --apply   # clean up a stuck task and retry
```

---

## Supporting skills

The loop selects a workflow skill for each task. These are also usable standalone in Claude/Codex:

| Skill | When the loop uses it | Standalone use |
| --- | --- | --- |
| [`grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md) | Planner discovery, ambiguous goals | Clarify requirements before implementing |
| [`diagnose`](./skills/engineering/diagnose/SKILL.md) | Bugs, failures, unknown root cause | Debug a failing test or crash |
| [`tdd`](./skills/engineering/tdd/SKILL.md) | Any task with observable behavior | Implement with red/green/refactor |
| [`zoom-out`](./skills/engineering/zoom-out/SKILL.md) | Unfamiliar or cross-module tasks | Understand code in broader context |
| [`improve-codebase-architecture`](./skills/engineering/improve-codebase-architecture/SKILL.md) | Structural cleanup tasks | Refactor a module boundary |
| [`update-project-md`](./skills/engineering/update-project-md/SKILL.md) | Post-run doc finalization | Refresh PROJECT.md from repo reality |
| [`handoff`](./skills/productivity/handoff/SKILL.md) | Loop stopped, human input needed | Hand off work to another session |

Full skill list: [`skills/engineering`](./skills/engineering/README.md) — [`skills/productivity`](./skills/productivity/README.md) — [`skills/misc`](./skills/misc/README.md)

---

## Agent guidance (templates)

The installer seeds `AGENTS.md`, `CLAUDE.md`, `PROJECT.md`, and `CONTEXT.md` into your product repo. These give every agent — loop or conversational — consistent operating principles, skill routing triggers, ADR capture rules, and scratch state conventions.

The templates include an **Agentic Loop Overlay** that overrides interactive-mode rules (caveman style, clarification pauses, one-question-at-a-time grill mode) for autonomous harness runs so agents don't stall waiting for a human that isn't there.

See [`templates/`](./templates/) for the full content.

---

## Ralph — lighter story runner

[`ralph`](./scripts/ralph/README.md) is a simpler loop over a PRD/user-story list. Same core principle — fresh agent per unit of work, persistent state on disk — without the planning and multi-agent verification machinery. Use it when you already have a task list and want straight execution.

```powershell
ralph --checks "npm test"
```

Use [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) to generate the input package from a PRD.

---

## Repository map

| Path | Purpose |
| --- | --- |
| [`tools/agent-loop/`](./tools/agent-loop/) | TypeScript harness CLI — planner, executor, verifier, state, prompts. |
| [`skills/`](./skills/) | Workflow skills used by the loop and standalone. |
| [`templates/`](./templates/) | Agent guidance files seeded into product repos on install. |
| [`scripts/bootstrap/`](./scripts/bootstrap/) | Installers for machines and product repos. |
| [`scripts/agentic/`](./scripts/agentic/) | PowerShell shim and harness reference docs. |
| [`scripts/ralph/`](./scripts/ralph/) | Ralph harness. |
| [`docs/`](./docs/) | Reference docs and flow diagram. |
| [`tests/`](./tests/) | Harness smoke tests. |

---

## References

- Upstream skills base: [`mattpocock/skills`](https://github.com/mattpocock/skills)
- Operating-principles inspiration: [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills/tree/main)
- Optional codebase graph context: [`codegraph`](https://github.com/codegen-sh/codegraph)
