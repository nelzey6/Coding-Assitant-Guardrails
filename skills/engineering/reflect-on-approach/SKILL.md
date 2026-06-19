---
name: reflect-on-approach
description: Challenge and refine a technical approach from a fresh perspective before or during complex implementation work, and reassess whether a remaining plan is still valid after material discoveries. Use when a task is architecturally significant, cross-module, assumption-heavy, costly to reverse, or when the user asks to reassess, readjust, reconfirm, reflect, or reconsider an approach.
---

# Reflect on Approach

Use this skill to improve the chosen route, not to rediscover requirements or verify finished code.

- Use `grill-with-docs` first when intent, terminology, acceptance criteria, or human decisions remain unclear.
- Use the selected implementation workflow to perform the work.
- Use the verifier to judge whether completed work is correct.

## Evidence first

Read the goal, task, acceptance criteria, repository guidance, relevant source and tests, decisions, and prior reflection. In later rounds, inspect what changed. Do not approve an approach from its summary alone.

Keep these scopes separate:

- `stance`: refine the technical approach before edits begin.
- `checkpoint`: reassess the current task's stance after a planned implementation milestone.
- `plan`: reassess pending tasks after a material outcome or discovery.

## Stance mode

Start with an explicit proposed stance: owning abstraction, boundaries, sequence, expected edits, validation, assumptions, and rejected alternatives.

Challenge it from a genuinely different perspective:

1. What framing or assumption may be wrong?
2. Is responsibility placed in the correct module or abstraction?
3. Is there a smaller, safer, or more reversible route?
4. What downstream behavior, migration seam, or failure mode is missing?
5. What evidence would falsify this stance before implementation?

Return `reconfirm`, `readjust`, `reassess`, or `needs_human`. `readjust` must provide a revised stance. `reassess` means more repository evidence is required. Do not edit implementation files in stance mode.

In iterative rounds, respond to the previous critique rather than repeating it. Stop at the caller's round limit or convergence rule.

## Checkpoint mode

At each predefined milestone, compare actual evidence with the approved stance. Return:

- `continue`: evidence supports the stance.
- `adjust`: revise only the current task's approach or remaining checkpoints.
- `needs_plan_review`: discoveries may invalidate pending tasks.
- `needs_human`: continuing requires a decision the agent must not invent.

Do not reorder, replace, or create pending tasks in checkpoint mode.

## Plan mode

Compare the original goal and pending tasks with completed outcomes, changed assumptions, cumulative diff, validation evidence, and newly discovered constraints.

Return `continue`, `adjust_remaining_tasks`, `replan`, or `needs_human`. Preserve completed tasks as history. Identify pending tasks that are stale, redundant, incorrectly ordered, wrongly scoped, or insufficient. The planner or harness—not this reflection—owns task mutation.

## Output contract

Produce a structured result containing:

- `mode` and `verdict`
- `summary`
- `evidence`
- `assumptions_challenged`
- `perspectives_considered`
- `recommended_changes`
- `unresolved_risks`
- `needs_plan_review`
- `next_action`

Recommendations must cite concrete repository evidence. Reconfirmation must explain why the challenged stance survived; never return a bare approval.
