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

By default this installs both Codex and Claude skills, installs the `agentic-loop` and `ralph` shims, and seeds missing repo templates into the destination repo. CodeGraph is optional and deliberately installed separately; when present on PATH, the harness uses it automatically.

After installation, in your product repo you can run:

```powershell
agentic-loop --goal "Fix checkout reliability" --tool claude --plan-only
agentic-loop --status
agentic-loop --tool claude --checks "npm test" --review-branch
```

Or use the installed skills directly from Codex/Claude, for example:

```text
Use grill-with-docs before implementing this feature.
Use diagnose to investigate this failing test.
Use tdd for this bug fix.
Use update-project-md to refresh PROJECT.md.
```

## What gets installed

The installer can target Codex, Claude, or both. By default it:

- updates this skills repo checkout before installing;
- installs active skills into `~/.codex/skills` and/or `~/.claude/skills`;
- installs the `agentic-loop` harness and user-level shim;
- includes optional CodeGraph context helper scripts under `scripts/context/` plus separate third-party install notes under `third-party/codegraph/`;
- installs the `ralph` harness and user-level shim;
- seeds missing repo templates into the product repo when `-Destination` / `--destination` is provided;
- adds `.agent-runs/`, `.worktrees/`, `agentic.json`, and related runtime files to the product repo `.gitignore`.

Run installer help for less common options such as installing only one tool, skipping update, or using a non-default skills repo path.

## Product repo files

When you pass a destination repo, these files define how agents should work there:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Always-on Codex guidance and skill routing. Created only if missing. |
| `CLAUDE.md` | Always-on Claude Code guidance and skill routing. Created only if missing. |
| `PROJECT.md` | Technical repo map: commands, architecture, validation, debugging, file roles. Created only if missing. |
| `CONTEXT.md` | Product/domain language, decisions, assumptions, and business meaning. Created only if missing. |
| `.agent-policy/workflow-policy.json` | Machine-readable routing/gate policy for autonomous loops. Created only if missing. |

The templates live in [`templates/`](./templates/). `AGENTS.md` and `CLAUDE.md` are the main orchestrators: they tell agents when to use workflows such as `grill-with-docs`, `diagnose`, `tdd`, `zoom-out`, `update-project-md`, and `handoff`. The installer preserves existing persistent markdowns by default; overwrite template files only with the explicit force-overwrite installer option.

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

Complete active skill index:

- Engineering: [`agentic-loop`](./skills/engineering/agentic-loop/SKILL.md), [`diagnose`](./skills/engineering/diagnose/SKILL.md), [`grill-with-docs`](./skills/engineering/grill-with-docs/SKILL.md), [`improve-codebase-architecture`](./skills/engineering/improve-codebase-architecture/SKILL.md), [`prototype`](./skills/engineering/prototype/SKILL.md), [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md), [`setup-matt-pocock-skills`](./skills/engineering/setup-matt-pocock-skills/SKILL.md), [`tdd`](./skills/engineering/tdd/SKILL.md), [`to-issues`](./skills/engineering/to-issues/SKILL.md), [`to-prd`](./skills/engineering/to-prd/SKILL.md), [`triage`](./skills/engineering/triage/SKILL.md), [`update-project-md`](./skills/engineering/update-project-md/SKILL.md), [`zoom-out`](./skills/engineering/zoom-out/SKILL.md).
- Productivity: [`caveman`](./skills/productivity/caveman/SKILL.md), [`grill-me`](./skills/productivity/grill-me/SKILL.md), [`handoff`](./skills/productivity/handoff/SKILL.md), [`write-a-skill`](./skills/productivity/write-a-skill/SKILL.md).
- Misc: [`git-guardrails-claude-code`](./skills/misc/git-guardrails-claude-code/SKILL.md), [`migrate-to-shoehorn`](./skills/misc/migrate-to-shoehorn/SKILL.md), [`scaffold-exercises`](./skills/misc/scaffold-exercises/SKILL.md), [`setup-pre-commit`](./skills/misc/setup-pre-commit/SKILL.md).

See the linked bucket READMEs and `SKILL.md` files for details.

## Agentic loop harness

[`scripts/agentic/agentic-loop.ps1`](./scripts/agentic/agentic-loop.ps1) is the main autonomous coding harness. It is designed to be a safer, more inspectable `/goal`-style workflow.

High-level flow:

1. Plan from a goal into `agentic.json` tasks using grill-with-docs-style discovery.
2. Run one task at a time in a fresh git worktree/branch.
3. Invoke a fresh executor agent with a generated prompt.
4. Run configured checks and task validation commands.
5. Invoke a fresh verifier agent unless `--fast-verifier` is explicitly used.
6. Commit/merge or hold the result for human review.
7. Persist state, events, handovers, logs, diffs, and summaries under `.agent-runs/`.
8. On completion, refresh `PROJECT.md` through update-project-md-style finalization unless skipped.

Useful commands:

```powershell
agentic-loop --goal "Implement retry for flaky checkout" --tool claude --plan-only
agentic-loop --status
agentic-loop --tool claude --checks "npm test" --review-branch
agentic-loop --last-failure
agentic-loop --why-stuck
agentic-loop --summary
agentic-loop --accept task-001
```

Important runtime files:

| Path | Purpose |
| --- | --- |
| `agentic.json` | Local task graph and loop state. |
| `.agent-runs/events.jsonl` | Append-only lifecycle/event log. |
| `.agent-runs/<run>/executor.md` | Prompt given to a fresh executor agent. |
| `.agent-runs/<run>/verifier.md` | Prompt given to a fresh verifier agent. |
| `.agent-runs/<run>/handover.md` | Per-task future-self handover. |
| `.agent-runs/<planner-run>/grill-transcript.md` | Visible autonomous planning Q/A/evidence/proposal trail. |
| `.worktrees/<task-id>` | Isolated task worktree. |

For the full command reference, review flows, retry/reset behavior, diagnostics, final docs behavior, and smoke tests, see [`scripts/agentic/README.md`](./scripts/agentic/README.md).

### CodeGraph context

Pi does not need MCP support for CodeGraph in this setup. If a `codegraph` CLI is available on PATH, the agentic loop generates `codegraph.md` artifacts for planner and executor runs and points agents at those files. If CodeGraph is missing, the artifact says so and the run continues normally. See [`third-party/codegraph/README.md`](./third-party/codegraph/README.md) and [`scripts/context/codegraph-context.ps1`](./scripts/context/codegraph-context.ps1).

## Ralph harness

[`scripts/ralph/ralph.ps1`](./scripts/ralph/ralph.ps1) is a simpler fresh-agent loop over a Ralph-compatible `prd.json`.

Use it when you already have a PRD/user-story package and want the harness to execute one story at a time:

```powershell
ralph --tool claude --checks "npm test"
ralph --tool pi --checks "npm test"
```

Ralph keeps the same core principle as the agentic loop - persistent state on disk plus a fresh agent call per unit of work - but with less planning/verifier/review machinery. Use [`ralph-prd`](./skills/engineering/ralph-prd/SKILL.md) to produce the PRD package.

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
| [`scripts/agentic/`](./scripts/agentic/) | Agentic loop harness, setup script, and docs. |
| [`scripts/ralph/`](./scripts/ralph/) | Ralph harness, setup script, and docs. |
| [`tests/agentic/`](./tests/agentic/) | Focused harness smoke tests. |
| [`tests/ralph/`](./tests/ralph/) | Ralph smoke tests. |
| [`docs/adr/`](./docs/adr/) | Architecture decisions. |

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
