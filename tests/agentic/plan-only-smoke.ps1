#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-plan-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8

    $fake = Join-Path $tmp "fake-planner.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write planner JSON only to: (.+)") {
    $resultPath = $Matches[1].Trim()
    $transcriptPath = $null
    if ($content -match "Also write an autonomous grill transcript markdown file to: (.+)") { $transcriptPath = $Matches[1].Trim() }
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if ($transcriptPath) {
        @"
# Autonomous Grill Transcript
## Goal Restatement
Plan smoke.
## Questions, Evidence, Answers, Proposals
### Q1: What should be validated?
- Evidence inspected: README.md
- Autonomous answer: create smoke-output.txt.
- Proposal/decision: one tdd task with focused validation.
- Human input needed: no.
## Final Plan Rationale
One small implementation task is sufficient.
"@ | Set-Content -LiteralPath $transcriptPath -Encoding UTF8
    }
    @"
{
  "verdict": "planned",
  "summary": "planned smoke task",
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "artifacts": ["grill-transcript.md"],
  "tasks": [
    {
      "id": "task-001",
      "title": "Create smoke output",
      "kind": "implementation",
      "workflow": "tdd",
      "status": "pending",
      "priority": 1,
      "acceptanceCriteria": ["smoke-output.txt exists"],
      "validation": ["test -f smoke-output.txt"],
      "dependsOn": [],
      "failureHistory": [],
      "artifacts": []
    }
  ]
}
"@ | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
throw "Could not find planner result path"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --goal "Plan smoke" --plan-only
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($state.tasks.Count -ne 1) { throw "Expected one planned task" }
    if ($state.tasks[0].kind -ne "implementation") { throw "Expected implementation task" }
    $transcript = Get-ChildItem -Path (Join-Path $tmp ".agent-runs") -Recurse -Filter "grill-transcript.md" | Select-Object -First 1
    if ($null -eq $transcript) { throw "Expected planner grill-transcript.md" }
    if ((Get-Content -LiteralPath $transcript.FullName -Raw) -notmatch "Questions, Evidence, Answers, Proposals") { throw "Expected grill transcript question section" }
    $eventLog = Join-Path $tmp ".agent-runs/events.jsonl"
    if (!(Test-Path -LiteralPath $eventLog)) { throw "Expected planner events.jsonl" }
    $events = Get-Content -LiteralPath $eventLog -Raw
    if ($events -notmatch '"type":"planner_started"') { throw "Expected planner_started event" }
    if ($events -notmatch '"type":"planner_finished"') { throw "Expected planner_finished event" }
    if (Test-Path -Path (Join-Path $tmp ".worktrees")) {
        $children = @(Get-ChildItem -Path (Join-Path $tmp ".worktrees") -ErrorAction SilentlyContinue)
        if ($children.Count -gt 0) { throw "Plan-only should not create task worktrees" }
    }
    Write-Output "agentic plan-only smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
