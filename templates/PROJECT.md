# Project Guide

Project-specific facts and durable architecture truth for the shared agent guidelines.

Keep durable workflow rules in `AGENTS.md` or `CLAUDE.md`. Keep project-specific commands, architecture, validation, debugging paths, sources of truth, and constraints here.

Treat this file as maintained repo knowledge. Extend and correct it with small edits when durable facts change; do not regenerate it wholesale.

## Snapshot

- Purpose:
- Users:
- Tech stack:
- Runtime/deployment:
- Main directories:
- Constraints:

## Sources

- Code/schema:
- Architecture docs/ADRs:
- Product/domain docs:
- Tests/fixtures:
- Logs/traces/runtime records:

## Architecture

- Core modules/services:
- Ownership boundaries:
- Public seams/interfaces:
- State/data owners:
- Dependency direction:
- Anti-patterns:

## Commands

- Setup:
- Dev:
- Format:
- Lint/static analysis:
- Typecheck/compile:
- Targeted tests:
- Full tests:
- Build/package:
- Smoke/integration:
- Database/migrations:

## Debugging And Runs

- Logs/traces:
- Runtime records:
- Repro commands:
- Local services:
- Useful scripts:
- Agent scratch runs: `.agent-runs/` is local, temporary, and not committed.
- Flaky/slow checks:
- Health/quality signals:
- Completion expectations:

## Update Rule

Update this file only when durable project-specific architecture, commands, validation, debugging paths, sources of truth, or constraints change. Preserve existing useful content and patch the smallest relevant section.
