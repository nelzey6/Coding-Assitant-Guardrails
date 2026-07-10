# Vision

Coding assistants should not treat a prompt as a complete specification. A user may not yet know exactly what they need, while an agent that codes from surface-level instructions can produce a local fix that does not fit the codebase or remain sustainable as it grows.

Coding Assistant Guardrails exists to turn a well-stated goal into sustainable implementation by letting an agent investigate, challenge assumptions, make evidence-backed decisions, and repeatedly reassess its plan before and during execution.

## The Problem

- Prompt-only coding loses context quickly and often misunderstands the real request.
- Initial requests are frequently incomplete; intent becomes clearer through conversation and investigation.
- Without explicit reflection, agents tend to optimize for the immediate task instead of architecture, domain language, constraints, and long-term fit.

## The Thesis

High-quality agentic coding needs a structured discovery and execution loop. The agent should learn the project's language, inspect relevant evidence, work through the meaningful decision tree, and offer a well-supported recommendation by default.

For a focused, sufficiently described task, a capable agent should also grill itself: test its assumptions, examine alternatives, and improve its own plan before it edits code.

## Operating Model

```text
goal
  -> investigate repository and context
  -> grill unresolved questions
  -> record decisions and recommended options
  -> execute a focused task
  -> verify result
  -> reassess assumptions, scope, and remaining plan
  -> replan, zoom in, zoom out, or change perspective when evidence requires it
```

The purpose is not to ask questions indefinitely. It is to resolve material uncertainty before committing code, then keep reassessment proportional to task risk and complexity.

## Principles

- Treat a goal as a starting point for discovery, not a complete specification.
- Learn and use the codebase's domain language before inventing new terminology or abstractions.
- Make assumptions explicit; challenge them with code, documentation, tests, and runtime evidence.
- Present concrete recommended options when a real decision exists.
- Keep execution tasks focused enough that scope, ownership, and validation remain clear.
- Deliberately switch perspectives when needed: zoom into implementation detail, zoom out to architecture, and reconsider from a fresh stance.
- Reassess and replan when new evidence invalidates the remaining path.
- Prefer evidence-grounded, sustainable solutions within the actual constraints over the fastest local patch.

## Boundaries

This is not a mandate for infinite deliberation or unnecessary process. Questions, reflection rounds, and agents should stop when uncertainty is no longer material. High-impact product, safety, security, or irreversible decisions still require an explicit human checkpoint.
