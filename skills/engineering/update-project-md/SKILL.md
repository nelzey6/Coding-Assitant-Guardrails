---
name: update-project-md
description: Create or update PROJECT.md with durable repository facts: build/test commands, architecture map, validation paths, debugging paths, sources of truth, and constraints. Use during initial repo onboarding, after meaningful architecture/build/test/runtime changes, or when PROJECT.md appears stale.
---

# Update PROJECT.md

Create or update the repository's `PROJECT.md` so future agent sessions understand how this repo works technically.

`PROJECT.md` is durable architecture truth and a technical repo map. Treat it as a maintained source of truth that is extended and corrected over time, not as a generated report to overwrite.

## Boundaries

Use `PROJECT.md` for durable technical facts:

- build, test, lint, format, compile, and run commands
- repository layout and main modules
- architecture boundaries and ownership
- state/data owners
- dependency direction
- runtime services and deployment shape
- debugging paths, logs, traces, fixtures, and useful scripts
- CI expectations and validation strategy
- durable constraints and anti-patterns

Do not put these in `PROJECT.md`:

- live task state
- temporary hypotheses
- conversation summaries
- unresolved guesses presented as fact
- product/domain vocabulary better suited for `CONTEXT.md`
- architecture decisions that deserve an ADR

Use `CONTEXT.md` for domain language and product/business meaning. Use ADRs for significant irreversible decisions. Keep live task state in the conversation unless the user asks for a separate handoff or status document.

## Process

### 1. Inspect evidence

Read only what is needed, but prefer evidence over guesses:

- `git status`
- existing `PROJECT.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `CONTEXT-MAP.md`
- `README.md`, `docs/`, ADRs, runbooks
- CI files and task runners
- package/build files such as `package.json`, `pyproject.toml`, `pom.xml`, `build.gradle`, `CMakeLists.txt`, `Makefile`, `.sln`, `.csproj`, `Cargo.toml`, `go.mod`
- scripts directories
- test directories and representative tests
- config files and deployment manifests
- source tree layout and module boundaries

### 2. Separate facts from unknowns

Do not invent missing information.

If a command, owner, service, or boundary is not evident, write `TODO:` with the specific missing fact.

If multiple sources disagree, note the conflict and prefer current code, CI, and executable scripts over prose docs.

### 3. Preserve useful human content

If `PROJECT.md` already exists:

- patch it surgically
- update stale facts in place
- add new durable facts to the most relevant existing section
- preserve structure, ordering, tone, and useful manually written notes
- preserve unknowns and `TODO:` entries unless you have evidence that resolves them
- remove content only when it is clearly obsolete, duplicated, or contradicted by current evidence
- never replace the whole file unless the user explicitly asks for a full rewrite
- if a section is placeholder-only, fill that section rather than regenerating the file

### 4. Write PROJECT.md

If `PROJECT.md` is missing, create it from `templates/PROJECT.md`.

If `PROJECT.md` exists, do not force it into the template structure. Keep the existing structure unless a small section-level reorganization clearly improves accuracy and readability.

### 5. Report what changed

After editing, summarize:

- facts added or changed
- unresolved `TODO:` entries
- commands discovered
- any conflicts between docs, CI, scripts, and code
- whether `CONTEXT.md` or an ADR should also be updated

## Keep It Fresh

During normal work, update `PROJECT.md` only when you discover durable repo facts that would help future sessions:

- a build/test command was wrong or missing
- architecture ownership or module boundaries changed
- validation strategy changed
- runtime/debugging paths changed
- a source of truth moved
- a recurring anti-pattern or constraint became clear

Do not update it for every code change.

## Editing Discipline

Before writing, identify the exact section or bullets that need changes. Make the smallest diff that keeps `PROJECT.md` accurate.

In the final response, call out any changed sections so the user can review the architecture truth update separately from code changes.
