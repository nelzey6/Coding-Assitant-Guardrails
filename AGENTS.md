**REQUIRED: Before any work, read `templates/AGENTS.md` and `templates/CLAUDE.md` and follow all rules in both files.**

Skills are organized into bucket folders under `skills/`:

- `engineering/` — daily code work
- `productivity/` — daily non-code workflow tools
- `misc/` — kept around but rarely used
- `personal/` — tied to my own setup, not promoted
- `in-progress/` — drafts not yet ready to ship
- `deprecated/` — no longer used

Every skill in `engineering/`, `productivity/`, or `misc/` must have a reference in the top-level `README.md` and an entry in `.claude-plugin/plugin.json`. Skills in `personal/`, `in-progress/`, and `deprecated/` must not appear in either.

Each skill entry in the top-level `README.md` must link the skill name to its `SKILL.md`.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`.

Hard upstream-sync rule: do not modify files or skills that come unchanged from the original `mattpocock/skills` repository. This repo is merged from upstream regularly, so upstream-owned content must stay merge-friendly. Put local behavior, custom orchestration, and new workflows in clearly local files/skills/templates instead of editing upstream-derived files. If a change appears to require editing an upstream-derived file, stop and ask first, explaining the upstream merge risk and proposing a local overlay alternative.
