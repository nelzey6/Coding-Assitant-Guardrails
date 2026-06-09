#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-partial-run-message-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    git -C $tmp config core.autocrlf false
    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Partial run message smoke",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    { "id": "task-001", "title": "Runs first", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 1, "acceptanceCriteria": [], "validation": [], "dependsOn": [], "failureHistory": [], "artifacts": [] },
    { "id": "task-002", "title": "Remains pending", "kind": "implementation", "workflow": "tdd", "status": "pending", "priority": 2, "acceptanceCriteria": [], "validation": [], "dependsOn": [], "failureHistory": [], "artifacts": [] }
  ],
  "decisions": [], "assumptions": [], "openQuestions": [], "blockers": [], "promptPolicy": { "lessons": [] }
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match '"id":\s*"task-002"') { throw "task-002 should not run with max iterations 1" }
if ($content -match "verifier-result.json") {
    $content -match "Write JSON only to this path: (.+)" | Out-Null
    $resultPath = $Matches[1].Trim()
    '{ "verdict": "pass", "summary": "partial run smoke passed first task", "issues": [], "humanGates": [], "recommendedStatus": "passed", "artifacts": [] }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
"task-001" | Set-Content -Path "ran-task.txt" -Encoding UTF8
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $output = & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        if ($exitCode -ne 1) { throw "Expected max-iterations exhaustion exit code 1, got $exitCode. Output:`n$output" }
    } finally { Pop-Location }

    if ($output -notmatch "Reached max iterations \(1\)") { throw "Expected max-iterations message. Output:`n$output" }
    if ($output -notmatch "partial run") { throw "Expected message to identify this as a partial run. Output:`n$output" }
    if ($output -notmatch "completed 1 of 2 tasks") { throw "Expected message to summarize partial progress. Output:`n$output" }
    if ($output -notmatch "not a harness crash") { throw "Expected message to distinguish budget exhaustion from a crash. Output:`n$output" }

    Write-Output "agentic partial run message smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
