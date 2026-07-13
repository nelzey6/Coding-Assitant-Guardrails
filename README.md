# Autonomous Coding Loop

An adaptive agent harness that takes a goal, plans it into tasks, executes in an isolated git worktree, escalates only from evidence, and hands you back an unstaged diff.

Built for [Claude Code](https://claude.ai/code) and compatible CLI agents (`claude`, `pi`, custom).

```bash
agentic-loop init "Refactor the auth module to use the new token store"
agentic-loop run
```

That's it. Normal work pays for planning, execution, checks, and one risk-appropriate verification decision. Extra reasoning runs only when ambiguity, complexity, failure, drift, risk, or documentation changes require it.

**→ [Quickstart — get running in 2 minutes](#quickstart)**

---

## What this actually feels like

You give the loop a goal in plain English. It:

1. Reads your repo and figures out what the goal actually requires.
2. Resolves design questions during planning and stops if evidence cannot settle them.
3. Executes each task in an isolated branch/worktree, so your working tree stays clean throughout.
4. Skips a separate verifier for bounded low-risk documentation, uses one verifier for normal work, and three adversarial votes for high risk.
5. Applies the final diff to your main tree as **unstaged changes** — you see exactly what changed, nothing is committed until you say so.

You never need to babysit it mid-run. If it hits something that genuinely needs a human decision, it stops and tells you why.

---

## How it works

Each run admits these phases per task from evidence, preserving the full trace even when a phase is skipped:

| Phase | What happens |
|---|---|
| **Plan** | Planner agent reads the goal, runs `grill-with-docs` discovery, produces a task graph with acceptance criteria, scope globs, and validation commands. |
| **Replan admission** | Fresh planner tasks execute. Stale/manual tasks, changed planning context, and understanding-sensitive failures return directly to planner. Check failures retry directly. |
| **Approach reflection** | High-complexity tasks receive one `reflect-on-approach` self-challenge before implementation. |
| **Execute** | Executor agent works inside a shared run worktree (`agentic/run-<timestamp>`) on a dedicated branch. Every model phase is guarded against parent-checkout mutation. |
| **Scope rail** | Harness checks `git diff` before the verifier. Any file outside the task's declared scope fails the task immediately. |
| **Verify** | Bounded low-risk documentation relies on checks; normal work gets one verifier; high-risk work gets adversarial votes. |
| **Finalize docs** | Runs once only when durable documentation changed. |
| **Apply** | All task commits are applied to your main tree as unstaged changes. Run worktree is cleaned up. |

State persists in `agentic.json` so runs survive interruption and resume where they left off.

See the [current workflow diagram](./docs/agentic-loop-flow.md) for states, skills, verdicts, and implemented versus planned checkpoints.
See the [verification policy](./docs/verification-policy.md) for targeted-check selection and the rules for escalating to broad suites.

---

## Quickstart

### Step 1 — Clone this repo

```bash
git clone https://github.com/nelzey6/Coding-Assitant-Guardrails.git
cd Coding-Assitant-Guardrails
```

### Step 2 — Install into your product repo

```powershell
# Windows
.\scripts\bootstrap\setup-ai-skills.ps1 -Destination D:\Repos\MyProduct
```

```bash
# macOS / Linux
./scripts/bootstrap/setup-ai-skills.sh --destination "$HOME/src/my-product"
```

This seeds `AGENTS.md`, `CLAUDE.md`, `PROJECT.md`, `CONTEXT.md`, and the `agentic-loop` shim into your product repo.

### Step 3 — Run the loop

**Option A — Inside Claude Code (conversational)**

```
/agentic-loop Refactor the auth module to use the new token store
```

**Option B — Terminal (fully unattended)**

```bash
# From your product repo root
agentic-loop init "Refactor the auth module to use the new token store"
agentic-loop run
```

The loop auto-detects `claude` or `pi` as the executor. When it finishes, you get unstaged changes in your main tree.

```bash
# Optional: run with a specific check command
agentic-loop run --checks "npm test"

# Skip the apply step — keep changes in the run branch instead
agentic-loop run --no-apply
```

---

## After the run

When the loop completes, you'll find:

```bash
git status        # unstaged changes ready to review
git diff          # full diff of everything the loop did
git add -p        # stage what you want, chunk by chunk
git commit        # your commit, your message
```

Nothing is committed until you decide to commit it.

---

## Safety rails

The loop is designed to fail loudly rather than silently produce wrong output:

- **Clean-tree gate** — refuses to start with uncommitted changes unless `--allow-dirty`.
- **Adaptive phase admission** — ambiguity, complexity, failed checks, changed assumptions, risk, and documentation changes select only necessary paths. Every decision is logged.
- **Scope enforcement** — each task declares a glob list of files it may touch. Out-of-scope changes fail immediately before the verifier runs.
- **Adversarial verifiers** — three votes for resolved high risk; normal code uses one vote.
- **Retry budget** — failures retry with a failure-analysis artifact so the next attempt knows what went wrong. Budget exhaustion escalates to `needs_human`.
- **Complexity-gated stance reflection** — high-complexity work is challenged once before edits.
- **CodeGraph sync** — knowledge graph is synced for planning, execution context, and apply.

---

## Diagnostics

```bash
agentic-loop status           # task list and what's next
agentic-loop why-stuck        # explain blocked or needs_human tasks
agentic-loop last-failure     # most recent failure details
```

---

## Supporting skills

The loop selects a workflow skill for each task. These are also usable standalone in Claude/Codex:

| Skill | When the loop uses it | Standalone use |
|---|---|---|
| [`agentic-loop`](./skills/engineering/agentic-loop/SKILL.md) | Goal-driven autonomous task loop | Prepare or run autonomous work |
| [`git-commit-push`](./skills/engineering/git-commit-push/SKILL.md) | Intentional Git publication | Commit and push with detailed context and validation |
| [`grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md) | Planner discovery, ambiguous goals | Clarify requirements before implementing |
| [`diagnose`](./skills/engineering/diagnose/SKILL.md) | Bugs, failures, unknown root cause | Debug a failing test or crash |
| [`tdd`](./skills/engineering/tdd/SKILL.md) | Any task with observable behavior | Implement with red/green/refactor |
| [`zoom-out`](./skills/engineering/zoom-out/SKILL.md) | Unfamiliar or cross-module tasks | Understand code in broader context |
| [`improve-codebase-architecture`](./skills/engineering/improve-codebase-architecture/SKILL.md) | Structural cleanup tasks | Refactor a module boundary |
| [`prototype`](./skills/engineering/prototype/SKILL.md) | Design or state-machine exploration | Build a throwaway prototype |
| [`reflect-on-approach`](./skills/engineering/reflect-on-approach/SKILL.md) | Complex or assumption-heavy technical work | Reassess, readjust, and reconfirm an implementation stance |
| [`setup-matt-pocock-skills`](./skills/engineering/setup-matt-pocock-skills/SKILL.md) | Repo agent-skill setup | Seed agent docs and issue-tracker conventions |
| [`to-issues`](./skills/engineering/to-issues/SKILL.md) | Break plans into tracked work | Convert a plan into issues |
| [`to-prd`](./skills/engineering/to-prd/SKILL.md) | Product planning handoff | Turn context into a PRD |
| [`triage`](./skills/engineering/triage/SKILL.md) | Issue workflow preparation | Triage incoming work |
| [`update-project-md`](./skills/engineering/update-project-md/SKILL.md) | Post-run doc finalization | Refresh PROJECT.md from repo reality |
| [`caveman`](./skills/productivity/caveman/SKILL.md) | Compact autonomous communication | Use compressed output style |
| [`grill-me`](./skills/productivity/grill-me/SKILL.md) | Plan stress-testing | Interrogate a plan before building |
| [`handoff`](./skills/productivity/handoff/SKILL.md) | Loop stopped, human input needed | Hand off work to another session |
| [`write-a-skill`](./skills/productivity/write-a-skill/SKILL.md) | Skill authoring support | Create a new skill package |
| [`git-guardrails-claude-code`](./skills/misc/git-guardrails-claude-code/SKILL.md) | Git safety setup | Add Claude Code git guardrails |
| [`migrate-to-shoehorn`](./skills/misc/migrate-to-shoehorn/SKILL.md) | Test fixture cleanup | Replace test assertions with shoehorn |
| [`scaffold-exercises`](./skills/misc/scaffold-exercises/SKILL.md) | Course exercise setup | Scaffold exercise files |
| [`setup-pre-commit`](./skills/misc/setup-pre-commit/SKILL.md) | Repo quality gate setup | Add pre-commit hooks |

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
|---|---|
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
