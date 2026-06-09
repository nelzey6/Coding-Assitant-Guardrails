# Claude and Codex Skills

Shared AI-agent skills and repo templates for Claude Code and Codex.

This repository is based on `mattpocock/skills` and adds:

- a machine-level installer for Codex, Claude, or both
- reusable repo templates for `AGENTS.md`, `CLAUDE.md`, `PROJECT.md`, `CONTEXT.md`, and `.agent-policy/workflow-policy.json`
- an `update-project-md` skill for keeping `PROJECT.md` aligned with repository reality
- trigger-based default routing for skills such as `grill-with-docs`, `diagnose`, `tdd`, and `zoom-out`

## Table Of Contents

- [Quick Start](#quick-start)
- [What The Installer Does](#what-the-installer-does)
- [Product Repo Files](#product-repo-files)
- [Agent Orchestration](#agent-orchestration)
- [Using Skills](#using-skills)
- [Available Skill Groups](#available-skill-groups)
- [Ralph Harness](#ralph-harness)
- [Updating From Upstream](#updating-from-upstream)

## Quick Start

Run from this repository folder. The installer updates this checkout from its configured git remote by default, then re-runs itself so the latest scripts are used.

Windows PowerShell:

```powershell
.\scripts\bootstrap\setup-ai-skills.ps1 -Destination D:\Repos\MyProduct
```

macOS/Linux Bash:

```bash
./scripts/bootstrap/setup-ai-skills.sh --destination "$HOME/src/my-product"
```

That installs both Codex and Claude skills by default and copies repo templates into the product repo.

For less common options such as installing only one tool, skipping update, or using a different skills repo path, run the scripts with `--help` / PowerShell parameter completion.

## What The Installer Does

By default, the installer:

1. Updates this skills repo checkout with `git fetch --prune` and `git pull --ff-only`.
2. Re-runs itself so updated installer code is used.
3. Installs all active skills into both Codex and Claude skill directories.
4. Installs the Ralph harness under the installed `ralph-prd` skill folder and creates a user-level `ralph` shim.
5. Installs the agentic loop harness under the installed `agentic-loop` skill folder and creates a user-level `agentic-loop` shim.
6. If `-Destination` / `--destination` is provided, copies repo templates into that product repo.
7. Adds `.agent-runs/`, `.worktrees/`, and `agentic.json` to the product repo `.gitignore`.

Codex skills install to `~/.codex/skills` (or `%USERPROFILE%\.codex\skills` on Windows). Claude skills install to `~/.claude/skills` (or `%USERPROFILE%\.claude\skills` on Windows).

## Product Repo Files

When `-Destination` / `--destination` is provided:

- `AGENTS.md` is overwritten for Codex guidance.
- `CLAUDE.md` is overwritten for Claude guidance.
- `PROJECT.md` is created only if missing.
- `CONTEXT.md` is created only if missing.
- `.agent-policy/workflow-policy.json` is created only if missing.
- `.agent-runs/`, `.worktrees/`, and `agentic.json` are added to `.gitignore`.

File roles:

```text
AGENTS.md  = always-on Codex behavior for a product repo
CLAUDE.md  = always-on Claude behavior for a product repo
PROJECT.md                  = technical repo map: commands, architecture, validation, debugging
CONTEXT.md                  = domain language and product/business meaning
.agent-policy/workflow-policy.json = machine-readable routing/gate policy for autonomous loops
SKILL.md                    = reusable workflow loaded when triggered or requested
```

## Agent Orchestration

[`templates/AGENTS.md`](./templates/AGENTS.md) and [`templates/CLAUDE.md`](./templates/CLAUDE.md) are the main orchestrators.

- `AGENTS.md` is for Codex.
- `CLAUDE.md` is for Claude Code.
- They define default behavior, validation expectations, scratch-state rules, ADR handling, and when to invoke installed skills.
- They route work automatically to skills such as `grill-with-docs`, `diagnose`, `tdd`, `zoom-out`, `improve-codebase-architecture`, `update-project-md`, and `handoff` based on task triggers.

The individual `SKILL.md` files stay reusable and upstream-friendly. Put repo-specific orchestration in `AGENTS.md` / `CLAUDE.md` instead of editing upstream skills when possible.

## Using Skills

Skills are triggered by asking the agent to use them by name or by giving a task that matches their description and the routing rules in `AGENTS.md` or `CLAUDE.md`.

Examples:

```text
Use update-project-md to inspect this repo and fill PROJECT.md.
```

```text
Use grill-with-docs before we implement this feature.
```

```text
Use diagnose to investigate this failing integration test.
```

```text
Use tdd for this bug fix.
```

## Available Skill Groups

Skills are organized under:

- `skills/engineering`
- `skills/productivity`
- `skills/misc`

Useful starting points:

- `update-project-md`: create or refresh `PROJECT.md` with durable repository facts
- `grill-with-docs`: clarify requirements and update domain context
- `diagnose`: disciplined debugging loop
- `tdd`: red-green-refactor development workflow
- `zoom-out`: understand code in broader system context
- `improve-codebase-architecture`: identify architecture improvement opportunities
- `handoff`: create a compact handoff for another agent or session
- [`agentic-loop`](./skills/engineering/agentic-loop/SKILL.md): prepare or run an autonomous coding loop with grill-with-docs discovery, policy-based workflow routing, worktrees, verification, reflection, and human gates
- `ralph-prd`: interview until decisions are clear, then create a human-readable PRD and Ralph-compatible `prd.json`

Check individual `SKILL.md` files for exact behavior.

## Agentic Loop Harness

[`scripts/agentic/agentic-loop.ps1`](./scripts/agentic/agentic-loop.ps1) runs a policy-driven autonomous coding loop over local `agentic.json` state. The setup script installs a user-level `agentic-loop` shim.

Typical safe flow:

```powershell
agentic-loop --goal "Fix checkout reliability" --tool claude --plan-only
agentic-loop --status
agentic-loop --tool claude --checks "npm test" --no-merge
agentic-loop --accept task-001
```

Use `--no-merge` while reviewing autonomous output. A passed no-merge task remains on `agentic/<safe-task-id>` with a worktree under `.worktrees/`; after review, `--accept <task-id>` integrates it and cleans up. `--accept` defaults to `--merge-mode ff-only`; pass `--merge-mode cherry-pick` or `--merge-mode no-ff` only when that merge behavior is intentional. `--status` can be run even when the worktree is dirty. The loop creates prompts under `.agent-runs/` and keeps `agentic.json` as ignored local runtime state.

## Ralph Harness

[`scripts/ralph/ralph.ps1`](./scripts/ralph/ralph.ps1) runs a fresh-agent loop over a Ralph-compatible [`prd.json`](./skills/engineering/ralph-prd/SKILL.md). The setup script installs this harness under the installed `ralph-prd` skill folder and creates a user-level `ralph` shim, so product repos do not need a copy of the script.

Ralph loop logic:

1. Start only from a clean git working tree, unless `--allow-dirty` is passed.
2. Read `prd.json`, using `userStories` or a top-level story array as the state source.
3. Pick the next unfinished story (`passes != true`), sorted by `priority` and then `id`.
4. Generate a one-story prompt under `.agent-runs/ralph-<timestamp>-<story-id>/prompt.md`.
5. Launch a fresh agent with the configured adapter: `--tool claude`, `--tool pi`, or `--tool custom --command '... {prompt} ...'`.
6. Run every configured `--checks` command after the agent exits successfully. If no checks are configured, agent exit success is treated as validation.
7. If validation passes and the working tree changed, set that story's `passes` field to `true` in `prd.json`.
8. Append a concise iteration entry to `progress.txt`.
9. Commit the iteration as `ralph: complete <story-id>`, unless `--no-commit` is set.
10. Repeat until all stories pass, then print `<promise>COMPLETE</promise>`, or stop when the max iteration budget is reached.

Use [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) to create the PRD package. Its most important job is **good story slicing**: small vertical stories with observable acceptance criteria. Ralph succeeds on architecture work only when the redesign is sliced into safe migration steps, not broad rewrite tasks.

Typical run:

```powershell
ralph --tool claude --checks "npm test"
ralph --tool pi --checks "npm test"
```

`prd.json.maxIterations` defines the default iteration budget. `--max-iterations` overrides it. Ralph stops early when all stories pass; the max is only a safety cap. For complex redesigns, set `maxIterations` to story count plus buffer, and prefer multiple phased PRDs when human review checkpoints are needed.

See [`scripts/ralph/README.md`](./scripts/ralph/README.md) for the compact harness reference and [`tests/ralph/smoke.ps1`](./tests/ralph/smoke.ps1) for a five-iteration fake-agent smoke test.

## Updating From Upstream

Keep custom orchestration in [`templates/AGENTS.md`](./templates/AGENTS.md) / [`templates/CLAUDE.md`](./templates/CLAUDE.md) where possible, not inside upstream skill files. This keeps syncs from `mattpocock/skills` easier.

To bring in upstream changes:

```bash
git fetch upstream
git merge upstream/main
```

Resolve conflicts deliberately. Keep custom skills and templates isolated where possible so upstream merges stay manageable.

## References

This repository is based on [`mattpocock/skills`](https://github.com/mattpocock/skills).

The Operating Principles in [`templates/AGENTS.md`](./templates/AGENTS.md) and [`templates/CLAUDE.md`](./templates/CLAUDE.md) are adapted from [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills/tree/main).

The Ralph loop is implemented locally in [`scripts/ralph/ralph.ps1`](./scripts/ralph/ralph.ps1), documented in [`scripts/ralph/README.md`](./scripts/ralph/README.md), and paired with the [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) skill for producing story-sliced `prd.json` input.
