---
name: git-commit-push
description: Commit and push intentional repository changes with scope review, targeted validation, and a detailed context-rich commit message. Use when the user asks to commit, push, publish, or land local Git changes on a remote branch.
---

# Git Commit and Push

## Git safety rules

Preserve user work. Never run destructive commands unless the user explicitly
authorizes that exact operation: `reset --hard`, `clean`, discard-style
`checkout`/`restore`, branch/worktree deletion, force push, rebase, amend,
history rewriting, or remote-branch replacement. If conflict, divergence,
dirty state, or push failure appears, inspect read-only and report; never guess
which work should be discarded.

## Workflow

1. Inspect repository state:

   ```bash
   git status --short --branch
   git diff --stat
   git diff --name-only
   git remote -v
   git branch -vv
   ```

2. Confirm scope. Preserve unrelated user changes. Do not stage untracked or
   modified files merely because they are present. If scope is ambiguous, ask
   before staging.

3. Review the actual diff. Group changes by behavior, architecture, docs, and
   tests. Check for secrets, generated artifacts, debug output, accidental
   formatting churn, and files outside the requested scope.

4. Run the smallest useful validation for the changed seam. Prefer targeted
   checks; broaden only when shared contracts, unknown impact, release risk, or
   an explicit user request justifies it. Record incomplete checks honestly.

5. Stage only the intended files or hunks. Re-run `git diff --cached --check`
   and inspect the staged diff before committing.

6. Write an extensive commit message using this shape:

   ```text
   <imperative subject, <=72 characters>

   What changed:
   - Name the important files/modules and behavior changes.

   Why:
   - Explain the problem, user goal, or failure being addressed.

   Design and safety:
   - Explain boundaries, tradeoffs, compatibility, and notable risks.

   Validation:
   - List exact commands and results.
   - State what was intentionally not run and why.
   ```

   Prefer concrete names, state transitions, and observable behavior over
   vague phrases such as "update stuff" or "fix issues".

7. Commit only after staged review passes:

   ```bash
   git commit -m "<subject>" -m "<detailed body>"
   ```

8. Verify the commit locally:

   ```bash
   git show --stat --oneline HEAD
   git status --short --branch
   ```

9. Push the current branch to its configured upstream. Do not silently push a
   different branch or force-update history:

   ```bash
   git push
   git status --short --branch
   git log -1 --oneline --decorate
   ```

## Stop conditions

Stop before commit/push for ambiguous scope, secrets, unexpected destructive or
generated changes, unresolved validation failure, unsafe upstream/history, or
auth/network/remote protection. Report the exact blocker; distinguish local
commit success from remote push success.

## Handoff

Report commit hash/subject, included behavior/files, validation results,
branch/upstream and push result, remaining changes, and unresolved risks.
