#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-validation-discovery-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Validation discovery smoke" -Encoding UTF8
    New-Item -ItemType Directory -Path (Join-Path $tmp "tests/agentic") -Force | Out-Null
    Set-Content -Path (Join-Path $tmp "tests/agentic/focused-smoke.ps1") -Value "Set-Content -LiteralPath focused-smoke-ran.txt -Value yes" -Encoding UTF8

    $ps = (Get-Process -Id $PID).Path
    $state = [pscustomobject]@{
        version = 1
        goal = "Plan and run focused validation smoke"
        maxIterations = 1
        checks = @("pwsh -File tests/agentic/focused-smoke.ps1")
        defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @()
        decisions = @()
        assumptions = @()
        openQuestions = @()
        blockers = @()
        promptPolicy = [pscustomobject]@{ lessons = @() }
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Planner result schema") {
    if ($content -notmatch "newly added focused smoke tests") { throw "planner prompt missing focused smoke validation guidance" }
    if ($content -match "powershell\.exe" -and $content -notmatch "legacy Windows PowerShell compatibility") { throw "planner prompt should limit powershell.exe to legacy compatibility" }
    if ($content -notmatch "pwsh -File") { throw "planner prompt missing pwsh -File guidance" }
    if ($content -match "Write planner JSON only to: (.+)") {
        $resultPath = $Matches[1].Trim()
        @{
            verdict = "planned"
            summary = "planned focused smoke validation"
            decisions = @()
            assumptions = @()
            openQuestions = @()
            blockers = @()
            tasks = @(@{
                id = "task-001"
                title = "Use focused smoke validation"
                kind = "implementation"
                workflow = "tdd"
                status = "pending"
                priority = 1
                acceptanceCriteria = @("focused smoke is listed as task validation")
                validation = @("pwsh -File tests/agentic/focused-smoke.ps1")
                dependsOn = @()
                failureHistory = @()
                artifacts = @("tests/agentic/focused-smoke.ps1")
            })
        } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resultPath -Encoding UTF8
        exit 0
    }
    throw "Could not find planner result path"
}
if ($content -match "verifier-result.json") {
    if ($content -match "Write JSON only to this path: (.+)") {
        '{ "verdict": "pass", "summary": "focused validation discovered", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $Matches[1].Trim() -Encoding UTF8
        exit 0
    }
}
if ($content -match "Task JSON") {
    if ($content -notmatch "newly added focused smoke tests") { throw "executor prompt missing focused smoke validation guidance" }
    if ($content -match "powershell\.exe" -and $content -notmatch "legacy Windows PowerShell compatibility") { throw "executor prompt should limit powershell.exe to legacy compatibility" }
    if ($content -notmatch "pwsh -File") { throw "executor prompt missing pwsh -File guidance" }
    "ok" | Set-Content -LiteralPath task-output.txt -Encoding UTF8
    exit 0
}
throw "Unexpected prompt"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $resultState = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($resultState.tasks[0].status -ne "passed") { throw "Expected task passed, got $($resultState.tasks[0].status)" }
    if (!(Test-Path -LiteralPath (Join-Path $tmp "focused-smoke-ran.txt"))) { throw "Expected focused smoke command to run" }

    Write-Output "agentic validation discovery smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
