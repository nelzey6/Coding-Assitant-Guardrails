# ADR-0001: Deterministic-only TypeScript CLI v1 (no LLM inside the CLI)

## Status

Superseded by [ADR-0002](./0002-ts-agent-loop-autonomous-runner.md).

## Context

The agentic harness (`scripts/agentic/agentic-loop.ps1`) is a 1,600-line PowerShell monolith. It handles planning (LLM-driven), execution, worktrees, merging, verifier voting, circuit-breakers, and state management. Adding validation (README/plugin/skill consistency) and plan scaffolding directly to the PS1 would deepen an already hard-to-test script.

A TypeScript CLI (`tools/agent-loop/`) was proposed to extract these concerns into typed, testable modules. The first design question was whether v1 should call an LLM (Claude) to produce plans or stay fully deterministic.

## Decision

v1 of the TS CLI contains no LLM calls. All logic in `validate` and `plan` is deterministic:

- `validate` reads the filesystem and checks invariants; it never calls an API.
- `plan` scaffolds a task list from static heuristics applied to the task text and repo context; it writes `plan.md` and never calls an API.

The PS1 remains the executor and LLM orchestrator. The TS CLI is a read-only pre-flight gate invoked by the `agentic-loop` skill before the PS1 runs.

This was true for the initial TS CLI slice. The TS tool later grew a full autonomous `run` command with agent invocation, task-grill, verification, retry, and replan support. See ADR-0002 for the current architecture decision.

## Tradeoffs

**Why deterministic:**
- A deterministic CLI is trivially testable and safe to invoke anywhere (dirty worktrees, CI, pre-commit).
- It establishes module boundaries and a typed data contract before LLM output shapes the API surface.
- A plan produced by static heuristics is reviewed by the assistant before being promoted to `agentic.json` — this keeps the human in the loop at the planning stage without requiring an API key.

**What this defers:**
- LLM-quality task decomposition, acceptance criteria generation, and dependency inference are not available in v1.
- The PS1's `--plan-only` path (LLM-driven) remains the canonical way to produce a full machine-ready plan. The TS `plan` command produces a human-review draft only.

**Why surprising without this context:**
A future contributor will see a CLI named `agent-loop` that scaffolds plans without calling an LLM and will reasonably ask "why doesn't this call Claude?" The answer is: trust is built incrementally. `apply` (which executes plans) is only added after dry-run planning is trusted. LLM planning inside the CLI is only added after `apply` is trusted.
