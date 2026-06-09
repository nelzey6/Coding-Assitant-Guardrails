#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-retry-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8

    $state = [pscustomobject]@{
        version = 1; goal = "Retry smoke"; maxIterations = 3; checks = @(); defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @(
            [pscustomobject]@{ id = "task-check-retry"; title = "Retry check failure"; kind = "implementation"; workflow = "tdd"; status = "pending"; priority = 1; acceptanceCriteria = @("passes on second attempt"); validation = @("test -f retry-output.txt"); dependsOn = @(); failureHistory = @(); artifacts = @() },
            [pscustomobject]@{ id = "task-manual-retry"; title = "Manual retry target"; kind = "implementation"; workflow = "tdd"; status = "needs_retry"; priority = 2; attempts = 1; acceptanceCriteria = @(); validation = @("test -f manual-output.txt"); dependsOn = @(); failureHistory = @(); artifacts = @() }
        )
        decisions = @(); assumptions = @(); openQuestions = @(); blockers = @(); promptPolicy = [pscustomobject]@{ lessons = @() }
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $fake = Join-Path $tmp "fake-agent.ps1"
@'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "You are the verifier") {
    $content -match "Write JSON only to this path: (.+)" | Out-Null
    '{ "verdict": "pass", "summary": "retry verifier passed", "issues": [], "humanGates": [], "recommendedStatus": "passed", "artifacts": [] }' | Set-Content -LiteralPath $Matches[1].Trim() -Encoding UTF8
    exit 0
}
if ($content -match '"id":\s*"task-check-retry"') {
    if ($content -match '"attempts":\s*2') { "ok" | Set-Content -LiteralPath "retry-output.txt" -Encoding UTF8 }
    exit 0
}
if ($content -match '"id":\s*"task-manual-retry"') {
    "ok" | Set-Content -LiteralPath "manual-output.txt" -Encoding UTF8
    exit 0
}
throw "Unexpected prompt"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = (Get-Process -Id $PID).Path
    Push-Location $tmp
    try {
        $help = & $ps -NoProfile -File $script --help
        if (($help -join "`n") -notmatch "--retry <task-id>" -or ($help -join "`n") -notmatch "normal next-task") { throw "Help does not document --retry selection semantics" }

        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 2 --max-retries 1
        if ($LASTEXITCODE -notin @(0, 1)) { throw "automatic retry run exited with $LASTEXITCODE" }

        $afterAuto = Get-Content -Path "agentic.json" -Raw | ConvertFrom-Json
        $autoTask = $afterAuto.tasks | Where-Object id -eq "task-check-retry"
        if ($autoTask.status -ne "passed") { throw "Expected automatic retry task passed, got $($autoTask.status)" }
        if ([int]$autoTask.attempts -ne 2) { throw "Expected automatic retry attempts=2, got $($autoTask.attempts)" }
        if (!(Test-Path -LiteralPath "retry-output.txt")) { throw "Expected retry-output.txt after automatic retry" }
        git add agentic.json | Out-Null
        git commit -m "record automatic retry state" | Out-Null

        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --retry task-manual-retry --max-iterations 1 --max-retries 2 --allow-dirty
        if ($LASTEXITCODE -ne 0) { throw "explicit retry run exited with $LASTEXITCODE" }
        $afterManual = Get-Content -Path "agentic.json" -Raw | ConvertFrom-Json
        $manualTask = $afterManual.tasks | Where-Object id -eq "task-manual-retry"
        if ($manualTask.status -ne "passed") { throw "Expected explicit retry task passed, got $($manualTask.status)" }
        if (!(Test-Path -LiteralPath "manual-output.txt")) { throw "Expected manual-output.txt after explicit retry" }

        $manualTask.status = "needs_retry"; $manualTask.attempts = 3
        $afterManual | ConvertTo-Json -Depth 20 | Set-Content -Path "agentic.json" -Encoding UTF8
        $oldErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try { & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --retry task-manual-retry --max-retries 1 --allow-dirty 2>$null }
        finally { $ErrorActionPreference = $oldErrorActionPreference }
        if ($LASTEXITCODE -eq 0) { throw "Expected exhausted explicit retry to fail" }
    } finally { Pop-Location }

    Write-Output "agentic retry smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
