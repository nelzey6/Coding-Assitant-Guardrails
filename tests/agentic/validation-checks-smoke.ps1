#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-validation-checks-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Validation checks smoke" -Encoding UTF8

    $ps = (Get-Process -Id $PID).Path
    Set-Content -Path (Join-Path $tmp "global-check.ps1") -Value "Add-Content -LiteralPath check-order.txt -Value global; if (!(Test-Path task-output.txt)) { throw 'missing task output' }" -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "state-check.ps1") -Value "Add-Content -LiteralPath check-order.txt -Value state; if (!(Test-Path task-output.txt)) { throw 'missing task output' }" -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "validation-check.ps1") -Value "Add-Content -LiteralPath check-order.txt -Value validation; Set-Content -LiteralPath validation-ran.txt -Value yes" -Encoding UTF8
    $globalCheck = "& ./global-check.ps1"
    $stateCheck = "& ./state-check.ps1"
    $validationCheck = "& ./validation-check.ps1"

    $state = [pscustomobject]@{
        version = 1
        goal = "Smoke task validation checks"
        maxIterations = 1
        checks = @($stateCheck)
        defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @([pscustomobject]@{
            id = "task-001"
            title = "Create task output"
            kind = "implementation"
            status = "pending"
            workflow = "tdd"
            priority = 1
            acceptanceCriteria = @("task-output.txt exists", "validation command runs before verifier")
            validation = @($stateCheck, $validationCheck, $validationCheck)
            dependsOn = @()
            failureHistory = @()
            artifacts = @()
        })
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
if ($content -match "verifier-result.json") {
    if (!(Test-Path -LiteralPath "validation-ran.txt")) { throw "validation command did not run before verifier" }
    if ($content -notmatch "PASS: .*validation-ran.txt|PASS: .*validation") { throw "verifier prompt did not include validation check output" }
    if ($content -match "Write JSON only to this path: (.+)") {
        $resultPath = $Matches[1].Trim()
        $parent = Split-Path -Parent $resultPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        '{ "verdict": "pass", "summary": "validation checks passed", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Write-Output "validation verifier passed"
        exit 0
    }
    throw "Could not find verifier result path"
}
"ok" | Set-Content -Path "task-output.txt" -Encoding UTF8
Write-Output "created task-output.txt"
'@ | Set-Content -Path $fake -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --checks $globalCheck --checks $stateCheck --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $resultState = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($resultState.tasks[0].status -ne "passed") { throw "Expected task passed, got $($resultState.tasks[0].status)" }
    if (!(Test-Path -Path (Join-Path $tmp "validation-ran.txt"))) { throw "Expected validation-ran.txt after merge" }

    $runDir = Join-Path $tmp $resultState.tasks[0].lastRunDir
    $checksLog = Get-Content -LiteralPath (Join-Path $runDir "checks.log") -Raw
    foreach ($check in @($globalCheck, $stateCheck, $validationCheck)) {
        $escaped = [regex]::Escape("PASS: $check")
        $count = ([regex]::Matches($checksLog, $escaped)).Count
        if ($count -ne 1) { throw "Expected exactly one PASS for [$check], got $count in checks.log:`n$checksLog" }
    }
    $order = Get-Content -LiteralPath (Join-Path $tmp "check-order.txt")
    $actualOrder = ($order -join ",")
    if ($actualOrder -ne "global,state,validation") { throw "Expected de-duplicated check order global,state,validation; got $actualOrder" }

    Write-Output "agentic validation checks smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
