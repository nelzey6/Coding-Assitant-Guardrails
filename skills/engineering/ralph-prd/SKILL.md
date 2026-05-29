---
name: ralph-prd
description: Compose grill-with-docs with Ralph output generation: interview until decisions are clear, then create a human-readable PRD and Ralph-compatible prd.json. Use when the user wants to prepare work for the Ralph harness or asks to create a Ralph PRD.
---

# Ralph PRD

Create a PRD package for `scripts/ralph/ralph.ps1`:

- a human-readable markdown PRD
- a machine-readable `prd.json`

This skill is intentionally modular. It does **not** duplicate the `grill-with-docs` interview/documentation rules. For discovery and questioning, load and follow `../grill-with-docs/SKILL.md`; this skill only adds Ralph-specific completion criteria and output formats.

## Inputs

Accept any of these as the starting point:

- a feature idea in the conversation
- an existing markdown PRD/spec
- an issue or set of issues
- notes in `.agent-runs/`

If the input is too vague, begin the `grill-with-docs` interview instead of drafting.

## Discovery and interview

Use `grill-with-docs` as the interview engine:

- inspect repo docs/code instead of asking questions the repo can answer
- ask one question at a time
- challenge fuzzy or conflicting domain language
- update `CONTEXT.md` only for durable domain terminology
- create/update ADRs only under the ADR rules from the active repository instructions and `grill-with-docs`

Additional Ralph-specific stopping rule: continue the interview until the work can be split into safe autonomous stories for a fresh-agent loop. **This is the core job of this skill:** Ralph succeeds or fails mostly on story slicing quality. Prefer asking more questions and producing smaller stories over handing Ralph a vague architecture task.

The PRD is ready when these are clear enough:

- user-visible behavior and success/failure states
- explicit out-of-scope boundaries
- UX/API/interface shape
- data, migration, compatibility, and default behavior if relevant
- permissions/auth/security if relevant
- integrations, jobs, config, environment, and operational effects if relevant
- validation commands or manual/browser checks
- story order, dependencies, and per-story scope

Stop when remaining ambiguity is safe implementation detail, not a product/design decision.

## ADR note

Do **not** create an ADR for every implementation or every story.

ADRs are only for durable, accepted, non-obvious decisions with real tradeoffs and meaningful reversal cost. Story slicing, ordinary implementation details, copy tweaks, and straightforward tests normally stay in the PRD only.

## Output files

Write both files together:

- human PRD: `tasks/prd-<slug>.md`
- Ralph JSON: `prd.json` by default, unless the user asks for another path

Create `tasks/` if needed.

If `prd.json` already exists, do not overwrite it silently. Ask whether to replace it, archive it, or write to another path.

## Human-readable PRD structure

Use this markdown structure:

```md
# <Feature title>

## Summary

## Goals

## Non-goals

## Users / actors

## Requirements

## Acceptance criteria

## Validation plan

## Story slices

### story-001 — <title>

- Goal:
- Acceptance criteria:
- Validation:
- Out of scope:
- Depends on:

## Decisions captured

- <decision> — <where captured, e.g. this PRD / CONTEXT.md / adrs/0001-name.md>

## Open questions

None. / <only questions safe to defer>
```

## `prd.json` shape

Use stable, small, vertical user stories. Each story must be realistic for one fresh-agent Ralph iteration.

Set `maxIterations` dynamically from the slice plan: normally `number of unfinished stories + buffer`. Use a small buffer for straightforward features and a larger buffer for architecture redesigns, but avoid one giant autonomous run; prefer phased PRDs when human checkpoints are needed.

```json
{
  "title": "Feature title",
  "branchName": "feature/short-slug",
  "prdPath": "tasks/prd-short-slug.md",
  "maxIterations": 8,
  "successCriteria": [
    "Observable overall outcome"
  ],
  "userStories": [
    {
      "id": "story-001",
      "title": "Small vertical slice",
      "priority": 1,
      "passes": false,
      "goal": "What this one iteration should accomplish",
      "acceptanceCriteria": [
        "Observable behavior"
      ],
      "validation": [
        "Command or manual check that proves this story"
      ],
      "outOfScope": [
        "What this story must not do"
      ],
      "dependsOn": []
    }
  ]
}
```

## Story slicing rules

Good slicing is the foundation of a good Ralph loop. Prefer vertical tracer-bullet stories over horizontal layers. Each story should touch only enough layers to deliver one observable capability.

Good stories:

- add the smallest persistence/API/UI path for one behavior
- support one new state or one edge case end-to-end
- add one validation path and its user-facing behavior

Bad stories:

- "build the whole dashboard"
- "implement backend"
- "refactor components"
- "add all tests"

If a story is too large for one agent context, split it before writing `prd.json`.

For complex architecture redesigns, slice by safe migration steps: characterize current behavior, introduce one seam, route one caller, migrate one behavior, delete one obsolete path. Use multiple PRDs/runs for phases instead of giving Ralph a broad rewrite.

## Final response

After writing files, summarize:

- PRD path
- `prd.json` path
- any ADRs created/updated
- suggested Ralph command, e.g. `ralph --tool claude --checks "<command>"`
- remaining risks, if any
