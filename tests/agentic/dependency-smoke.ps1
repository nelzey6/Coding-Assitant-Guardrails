#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-dep-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Dependency ordering smoke",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    { "id": "task-001", "title": "Already done", "kind": "discovery", "workflow": "zoom-out", "status": "passed", "priority": 1, "acceptanceCriteria": [], "validation": [], "dependsOn": [], "failureHistory": [], "artifacts": [] },
    { "id": "task-002", "title": "Should run", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 1, "acceptanceCriteria": [], "validation": [], "dependsOn": ["task-001"], "failureHistory": [], "artifacts": [] },
    { "id": "task-003", "title": "Should not run yet", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 0, "acceptanceCriteria": [], "validation": [], "dependsOn": ["task-002"], "failureHistory": [], "artifacts": [] }
  ],
  "decisions": [], "assumptions": [], "openQuestions": [], "blockers": [], "promptPolicy": { "lessons": [] }
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match '"id":\s*"task-003"') { throw "task-003 ran before dependency passed" }
if ($content -match "verifier-result.json") {
    $content -match "Write JSON only to this path: (.+)" | Out-Null
    $resultPath = $Matches[1].Trim()
    '{ "verdict": "pass", "summary": "dependency smoke passed", "issues": [], "humanGates": [], "recommendedStatus": "passed", "artifacts": [] }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
"task-002" | Set-Content -Path "ran-task.txt" -Encoding UTF8
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -notin @(0, 1)) { throw "agentic-loop exited with unexpected code $LASTEXITCODE" }
    } finally { Pop-Location }

    $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if (($state.tasks | Where-Object id -eq "task-002").status -ne "passed") { throw "Expected task-002 passed" }
    if (($state.tasks | Where-Object id -eq "task-003").status -ne "pending") { throw "Expected task-003 pending" }
    Write-Output "agentic dependency smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
