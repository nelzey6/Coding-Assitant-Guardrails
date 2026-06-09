#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Smoke test agentic loop",
  "maxIterations": 1,
  "checks": ["test -f smoke-output.txt"],
  "defaultDiscoveryWorkflow": "grill-with-docs",
  "tasks": [
    {
      "id": "task-001",
      "title": "Create smoke output",
      "status": "pending",
      "workflow": "tdd",
      "priority": 1,
      "acceptanceCriteria": ["smoke-output.txt exists"],
      "validation": ["test -f smoke-output.txt"],
      "dependsOn": [],
      "failureHistory": []
    }
  ],
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "promptPolicy": { "lessons": [] }
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "verifier-result.json") {
    if ($content -match "Write JSON only to this path: (.+)") {
        $resultPath = $Matches[1].Trim()
        $parent = Split-Path -Parent $resultPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        '{ "verdict": "pass", "summary": "smoke verifier passed", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Write-Output "smoke verifier passed"
        exit 0
    }
    throw "Could not find verifier result path"
}
"ok" | Set-Content -Path "smoke-output.txt" -Encoding UTF8
Write-Output "created smoke-output.txt"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = (Get-Process -Id $PID).Path
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($state.tasks[0].status -ne "passed") { throw "Expected task passed, got $($state.tasks[0].status)" }
    if (!(Test-Path -Path (Join-Path $tmp "smoke-output.txt"))) { throw "Expected smoke-output.txt after merge" }

    $runDir = Join-Path $tmp $state.tasks[0].lastRunDir
    $requiredArtifacts = @("executor.log", "checks.log", "verifier.log", "diff.patch", "diff-stat.txt", "state-before.json", "state-after.json")
    foreach ($artifact in $requiredArtifacts) {
        $path = Join-Path $runDir $artifact
        if (!(Test-Path -LiteralPath $path)) { throw "Expected run artifact missing: $artifact in $runDir" }
    }
    $before = Get-Content -LiteralPath (Join-Path $runDir "state-before.json") -Raw | ConvertFrom-Json
    $after = Get-Content -LiteralPath (Join-Path $runDir "state-after.json") -Raw | ConvertFrom-Json
    if ($before.tasks[0].status -ne "pending") { throw "Expected state-before task pending" }
    if ($after.tasks[0].status -ne "passed") { throw "Expected state-after task passed" }
    if ((Get-Content -LiteralPath (Join-Path $runDir "executor.log") -Raw) -notmatch "ok|smoke-output") { throw "Expected executor.log to capture executor output" }
    if ((Get-Content -LiteralPath (Join-Path $runDir "checks.log") -Raw) -notmatch "PASS: test -f smoke-output.txt") { throw "Expected checks.log to capture check output" }
    if ((Get-Content -LiteralPath (Join-Path $runDir "verifier.log") -Raw) -notmatch "smoke verifier passed|verifier-result") { throw "Expected verifier.log to capture verifier output" }
    if ((Get-Content -LiteralPath (Join-Path $runDir "diff.patch") -Raw) -notmatch "smoke-output.txt") { throw "Expected diff.patch before commit" }
    if ((Get-Content -LiteralPath (Join-Path $runDir "diff-stat.txt") -Raw) -notmatch "smoke-output.txt") { throw "Expected diff-stat.txt before commit" }
    Write-Output "agentic smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
