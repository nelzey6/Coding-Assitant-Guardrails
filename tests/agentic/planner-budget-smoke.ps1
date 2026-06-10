#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-budget-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Budget smoke" -Encoding UTF8

    # Planner emits an over-budget task first (8 acceptanceCriteria, 6 scope globs),
    # then a within-budget task on the repair pass. The harness must reject the first
    # and accept after repair.
    $fake = Join-Path $tmp "fake-planner.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
function Write-Transcript($c) {
    if ($c -match "Also write an autonomous grill transcript markdown file to: (.+)") {
        $t = $Matches[1].Trim()
        "# Autonomous Grill Transcript`n## Goal Restatement`nBudget smoke.`n## Questions, Evidence, Answers, Proposals`n## Final Plan Rationale`nok" | Set-Content -LiteralPath $t -Encoding UTF8
    }
}
# Repair prompt path: emit a valid, within-budget task.
if ($content -match "previous planner-result.json was invalid") {
    if ($content -match "Rewrite valid planner JSON only to: (.+)") {
        $resultPath = $Matches[1].Trim()
        $parent = Split-Path -Parent $resultPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        '{ "verdict": "planned", "summary": "fixed", "decisions": [], "assumptions": [], "openQuestions": [], "blockers": [], "artifacts": ["grill-transcript.md"], "tasks": [ { "id": "task-001", "title": "Small task", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 1, "acceptanceCriteria": ["does one thing"], "validation": [], "dependsOn": [], "failureHistory": [], "artifacts": [], "scope": ["src/**"] } ] }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
        exit 0
    }
    throw "repair: no result path"
}
# First planner pass: emit an over-budget task.
if ($content -match "Write planner JSON only to: (.+)") {
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Write-Transcript $content
    '{ "verdict": "planned", "summary": "too big", "decisions": [], "assumptions": [], "openQuestions": [], "blockers": [], "artifacts": ["grill-transcript.md"], "tasks": [ { "id": "task-001", "title": "Giant task", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 1, "acceptanceCriteria": ["a","b","c","d","e","f","g","h"], "validation": [], "dependsOn": [], "failureHistory": [], "artifacts": [], "scope": ["a/**","b/**","c/**","d/**","e/**","f/**"] } ] }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
throw "Could not find planner result path"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --goal "Budget smoke" --plan-only
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally { Pop-Location }

    # The repair must have been triggered (over-budget rejected) and the final task within budget.
    $repair = Get-ChildItem -Path (Join-Path $tmp ".agent-runs") -Recurse -Filter "planner-repair.md" | Select-Object -First 1
    if ($null -eq $repair) { throw "Expected planner-repair.md proving the over-budget task was rejected" }
    $repairText = Get-Content -LiteralPath $repair.FullName -Raw
    if ($repairText -notmatch "too many acceptanceCriteria") { throw "Expected acceptanceCriteria budget error in repair prompt" }
    if ($repairText -notmatch "too many scope globs") { throw "Expected scope-glob budget error in repair prompt" }

    $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($state.tasks.Count -ne 1) { throw "Expected one task after repair" }
    if (@($state.tasks[0].acceptanceCriteria).Count -gt 7) { throw "Final task still over acceptanceCriteria budget" }
    if (@($state.tasks[0].scope).Count -gt 5) { throw "Final task still over scope budget" }

    Write-Output "agentic planner budget smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
