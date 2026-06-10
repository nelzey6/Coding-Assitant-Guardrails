#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ps = Get-AgenticSmokePowerShell
$script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"

function New-ScopeRepo([string]$Tag) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-scope-smoke-$Tag-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Scope smoke" -Encoding UTF8
    return $tmp
}

# --- Case 1: executor writes an out-of-scope file -> scope_violation, not passed. ---
$tmp = New-ScopeRepo "violation"
try {
    $state = [pscustomobject]@{
        version = 1; goal = "scope violation"; maxIterations = 1; checks = @()
        defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @([pscustomobject]@{
            id = "task-scope"; title = "Touch only in-scope file"; kind = "implementation"
            status = "pending"; workflow = "tdd"; priority = 1
            acceptanceCriteria = @("writes allowed/in.txt"); validation = @(); dependsOn = @()
            failureHistory = @(); artifacts = @(); scope = @("allowed/**")
        })
        decisions = @(); assumptions = @(); openQuestions = @(); blockers = @()
        promptPolicy = [pscustomobject]@{ lessons = @() }
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "verifier") { throw "verifier should not run after a scope violation" }
New-Item -ItemType Directory -Force -Path "allowed" | Out-Null
"ok" | Set-Content -Path "allowed/in.txt" -Encoding UTF8
"sneaky" | Set-Content -Path "outside.txt" -Encoding UTF8
Write-Output "wrote in-scope and out-of-scope files"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1 2>$null
        # Non-zero exit is acceptable (needs_human path); we assert on state/events instead.
        $resultState = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        if ($resultState.tasks[0].status -eq "passed") { throw "Out-of-scope task must not pass" }
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"scope_violation"') { throw "Expected scope_violation event" }
        if ($events -notmatch "outside\.txt") { throw "Expected offending file recorded in event" }
    } finally { Pop-Location }
    Write-Output "scope violation case passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# --- Case 2: executor stays in scope -> scope_passed, task passes. ---
$tmp = New-ScopeRepo "clean"
try {
    $state = [pscustomobject]@{
        version = 1; goal = "scope clean"; maxIterations = 1; checks = @()
        defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @([pscustomobject]@{
            id = "task-scope"; title = "Touch only in-scope file"; kind = "implementation"
            status = "pending"; workflow = "tdd"; priority = 1
            acceptanceCriteria = @("writes allowed/in.txt"); validation = @(); dependsOn = @()
            failureHistory = @(); artifacts = @(); scope = @("allowed/**")
        })
        decisions = @(); assumptions = @(); openQuestions = @(); blockers = @()
        promptPolicy = [pscustomobject]@{ lessons = @() }
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    '{ "verdict": "pass", "summary": "in scope", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Write-Output "verifier passed"
    exit 0
}
New-Item -ItemType Directory -Force -Path "allowed" | Out-Null
"ok" | Set-Content -Path "allowed/in.txt" -Encoding UTF8
Write-Output "wrote in-scope file only"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "in-scope run should succeed" }
        $resultState = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        if ($resultState.tasks[0].status -ne "passed") { throw "Expected in-scope task to pass, got $($resultState.tasks[0].status)" }
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"scope_passed"') { throw "Expected scope_passed event" }
    } finally { Pop-Location }
    Write-Output "scope clean case passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Write-Output "agentic scope rail smoke passed"
