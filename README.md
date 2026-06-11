# Coding Assistant Guardrails

Reusable skills, repo templates, and autonomous-loop harnesses for Codex, Claude Code, and similar coding agents.

This repo gives a product repository three things:

1. **Always-on agent guidance** via `AGENTS.md` and `CLAUDE.md` templates.
2. **Reusable workflow skills** such as `grill-with-docs`, `diagnose`, `tdd`, `update-project-md`, and `handoff`.
3. **Optional automation harnesses** for fresh-agent loops: `agentic-loop` for task graphs and `ralph` for PRD/user-story execution.
4. **Optional CodeGraph context** as CLI-generated markdown artifacts, so agents can use graph orientation even without MCP support.

It is based on [`mattpocock/skills`](https://github.com/mattpocock/skills), with local templates and harnesses layered on top. Upstream-derived skill content is kept merge-friendly; local orchestration lives in templates, scripts, and local skills.

## Quick start

From this repository checkout, install skills and templates into a product repo:

```powershell
# Optional, before setup: install CodeGraph for graph-based repo context
.\third-party\codegraph\install-codegraph.ps1

# Windows PowerShell / PowerShell Core
.\scripts\bootstrap\setup-ai-skills.ps1 -Destination D:\Repos\MyProduct
```

```bash
# Optional, before setup: install CodeGraph for graph-based repo context
./third-party/codegraph/install-codegraph.sh

# macOS/Linux
./scripts/bootstrap/setup-ai-skills.sh --destination "$HOME/src/my-product"
```

By default this installs both Codex and Claude skills, the `agentic-loop` and `ralph` shims, and seeds missing repo templates (`AGENTS.md`, `CLAUDE.md`, `PROJECT.md`, `CONTEXT.md`) into the destination repo. Run `--help` on the installer for all options.

After installation, in your product repo:

```powershell
agentic-loop run --checks "npm test"   # run the autonomous loop
ralph --checks "npm test"              # run a PRD story list
```

Or invoke skills directly in Claude/Codex:

```
/agentic-loop Fix the flaky checkout tests
/grill-with-docs before implementing this feature
/diagnose this failing test
```

## Skills

Skills are reusable workflow instructions installed into Codex/Claude.

Active skill groups:

- [`skills/engineering`](./skills/engineering/README.md) - coding workflows and harness skills
- [`skills/productivity`](./skills/productivity/README.md) - everyday non-code workflow helpers
- [`skills/misc`](./skills/misc/README.md) - rarely used but still available skills

Common starting points:

- [`grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md) - clarify requirements, inspect docs/code, update durable context when needed.
- [`diagnose`](./skills/engineering/diagnose/SKILL.md) - disciplined debugging loop.
- [`tdd`](./skills/engineering/tdd/SKILL.md) - red/green/refactor implementation flow.
- [`zoom-out`](./skills/engineering/zoom-out/SKILL.md) - understand code in broader system context.
- [`update-project-md`](./skills/engineering/update-project-md/SKILL.md) - refresh `PROJECT.md` from repository reality.
- [`handoff`](./skills/productivity/handoff/SKILL.md) - create a compact handoff for another agent/session.
- [`agentic-loop`](./skills/engineering/agentic-loop/SKILL.md) - prepare or run the autonomous task harness.
- [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) - create a PRD plus Ralph-compatible `prd.json`.

See the bucket READMEs for the full list: [`skills/engineering`](./skills/engineering/README.md), [`skills/productivity`](./skills/productivity/README.md), [`skills/misc`](./skills/misc/README.md).

## Agentic loop harness

The agentic loop runs a goal autonomously: it plans the goal into tasks, then for each task spawns a fresh agent to execute, checks the result, and lets a verifier agent decide pass/fail. Each task runs in its own isolated git worktree so the main branch stays clean throughout.

### Two ways to run it

**Option A — Inside Claude Code (you are already in Claude)**

Just invoke the skill in the chat:

```
/agentic-loop Fix the flaky checkout tests
```

Claude plans the goal, then works through each task directly in the conversation — task-grill → execute → verify — and prints progress after each one. All artifacts still land in `.agent-runs/`. No subprocess needed.

**Option B — From a terminal (unattended, fresh agents per task)**

This is the full harness: each task gets a brand-new `pi` process for execution and verification, fully isolated from each other.

```powershell
# From your product repo root
agentic-loop run --checks "npm test"
```

`pi` is the default executor. To use Claude instead:

```powershell
agentic-loop run --tool claude --checks "npm test"
```

If you want to plan first and review before running:

```powershell
agentic-loop run --plan-only          # writes agentic.json, stops
agentic-loop run                      # resumes from the existing plan
```

### Useful commands

```powershell
agentic-loop status          # task list and what's next
agentic-loop why-stuck       # explain blocked/needs_human tasks
agentic-loop last-failure    # most recent failure
agentic-loop reset-task <id> --apply   # clean up a stuck task and retry
```

**More detail:** [scripts/agentic/README.md](./scripts/agentic/README.md) — [all flags & flows](./docs/agentic-loop-reference.md) — [visual diagram](./docs/agentic-loop-flow.md)

## Ralph harness

[`scripts/ralph/ralph.ps1`](./scripts/ralph/ralph.ps1) is a simpler fresh-agent loop over a Ralph-compatible `prd.json`.

Use it when you already have a PRD/user-story package and want the harness to execute one story at a time:

```powershell
ralph --tool claude --checks "npm test"
ralph --tool pi --checks "npm test"
```

Ralph keeps the same core principle as the agentic loop - persistent state on disk plus a fresh agent call per unit of work - but with less planning/verifier/human-inspection machinery. Use [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) to produce the PRD package.

For details, see [`scripts/ralph/README.md`](./scripts/ralph/README.md).

## Which workflow should I use?

| Need | Use |
| --- | --- |
| Clarify a feature or domain question | `grill-with-docs` |
| Debug a concrete failure | `diagnose` |
| Implement a focused change | `tdd` |
| Refresh durable technical repo docs | `update-project-md` |
| Run an autonomous multi-task coding goal | `agentic-loop` |
| Execute a pre-written PRD/story list | `ralph` |
| Hand work to another agent/session | `handoff` |

## Repository map

| Path | Purpose |
| --- | --- |
| [`templates/`](./templates/) | Product repo templates for agent guidance and policy. |
| [`skills/`](./skills/) | Installed workflow skills grouped by bucket. |
| [`scripts/bootstrap/`](./scripts/bootstrap/) | Machine/product-repo installers. |
| [`tools/agent-loop/`](./tools/agent-loop/) | TypeScript agent loop CLI and autonomous runner. |
| [`scripts/agentic/`](./scripts/agentic/) | Legacy PowerShell agentic loop harness, setup script, and docs. |
| [`scripts/ralph/`](./scripts/ralph/) | Ralph harness, setup script, and docs. |
| [`tests/agentic/`](./tests/agentic/) | Focused harness smoke tests. |
| [`tests/ralph/`](./tests/ralph/) | Ralph smoke tests. |
| [`adrs/`](./adrs/) | Current root architecture decisions. |
| [`docs/adr/`](./docs/adr/) | Older architecture decisions retained for history. |

## Updating from upstream

This repo is merged from upstream `mattpocock/skills` regularly. Keep local behavior in local templates, harnesses, and local skills rather than editing upstream-derived files.

To update:

```bash
git fetch upstream
git merge upstream/main
```

Resolve conflicts deliberately. Preserve the separation between upstream skill content and local orchestration.

## References

- Upstream base: [`mattpocock/skills`](https://github.com/mattpocock/skills)
- Operating-principles inspiration: [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills/tree/main)
- Optional codebase graph context: [`codegraph`](https://github.com/codegen-sh/codegraph)
