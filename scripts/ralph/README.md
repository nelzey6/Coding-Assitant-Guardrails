# Ralph harness

This is a local Ralph-style harness for Claude and pi first. It repeatedly launches a fresh coding-agent CLI against one unfinished story from `prd.json`, runs optional checks, marks the story passing, and commits. Other CLIs can still be used through the generic `--command` hook later.

Ralph works best when `prd.json` is sliced into small vertical stories. The harness is intentionally simple: story quality, validation commands, and human checkpoints determine whether a complex run succeeds.

## Quick start

Create `prd.json`:

```json
{
  "maxIterations": 3,
  "userStories": [
    { "id": "story-001", "title": "Example", "priority": 1, "passes": false, "acceptanceCriteria": [] }
  ]
}
```

Run with a known adapter after the main setup script has installed the user-level `ralph` shim:

```powershell
ralph --tool claude --checks "npm test"
ralph --tool pi --checks "npm test"
```

Or run the checked-out script directly:

```powershell
pwsh -File scripts/ralph/ralph.ps1 --tool claude --checks "npm test"
```

For any other CLI, pass a command template. `{prompt}` is replaced with a generated prompt file path:

```powershell
ralph --tool custom --command 'my-agent run --prompt-file {prompt}' --checks "npm test"
```

## Notes

- Requires `git` and PowerShell (`pwsh` recommended for cross-platform use; Windows PowerShell also works on Windows).
- Main setup copies `ralph.ps1` into the installed `ralph-prd` skill folder and creates a user-level `ralph` shim (`~/bin` on Windows, `~/.local/bin` or `~/bin` on Unix-like shells).
- Starts only from a clean working tree unless `--allow-dirty` is passed.
- Uses `.agent-runs/` for generated prompts.
- Uses `progress.txt` for iteration notes.
- `--max-iterations` overrides `prd.json.maxIterations`; if neither is set, Ralph uses `10`.
- `maxIterations` is a safety budget, not the success definition. Ralph stops early when all stories pass.
- For architecture redesigns, prefer phased PRDs and small migration stories over one broad rewrite story.
- Does not edit upstream-derived skills. The generated prompt repeats that repository rule.
- Built-in CLI adapters are best-effort; if a CLI changes flags, use `--command`.

## Smoke test

Run the fake-agent smoke test without calling Claude or pi:

```powershell
pwsh -File tests/ralph/smoke.ps1
```

The test creates a temporary git repo, runs Ralph with `--tool custom`, verifies the generated prompt reaches the fake agent, checks that validation gates `passes=true`, and confirms a second run reports `<promise>COMPLETE</promise>`.
