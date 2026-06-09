#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-auto-accept-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Auto accept smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Auto-accept no-merge dependencies",
  "maxIterations": 2,
  "checks": [],
  "tasks": [
    { "id": "dep task", "title": "Dependency", "kind": "implementation", "status": "pending", "workflow": "tdd", "priority": 1, "validation": [], "acceptanceCriteria": [], "dependsOn": [], "failureHistory": [] },
    { "id": "child task", "title": "Child", "kind": "implementation", "status": "pending", "workflow": "tdd", "priority": 2, "validation": [], "acceptanceCriteria": [], "dependsOn": ["dep task"], "failureHistory": [] }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $executor = Join-Path $tmp "executor.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match '"id"\s*:\s*"dep task"') {
    Set-Content -Path "dep.txt" -Value "dep" -Encoding UTF8
} elseif ($content -match '"id"\s*:\s*"child task"') {
    if (!(Test-Path -LiteralPath "dep.txt")) { throw "child did not see accepted dependency change" }
    Set-Content -Path "child.txt" -Value "child" -Encoding UTF8
} else {
    throw "Could not identify task from prompt"
}
'@ | Set-Content -Path $executor -Encoding UTF8

    $verifier = Join-Path $tmp "verifier.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -notmatch 'Write JSON only to this path:\s*(.+)') { throw "Result path not found" }
$resultPath = $Matches[1].Trim()
@{ verdict = "pass"; summary = "ok"; artifacts = @() } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
'@ | Set-Content -Path $verifier -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "add smoke helpers" | Out-Null

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = Get-AgenticSmokePowerShell

    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --no-merge --auto-accept-passed --merge-mode ff-only --command "& '$executor' '{prompt}'" --verifier-command "& '$verifier' '{prompt}'" --max-iterations 2
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop auto-accept exited with $LASTEXITCODE" }
    } finally { Pop-Location }

    if (!(Test-Path -LiteralPath (Join-Path $tmp "dep.txt"))) { throw "Expected dependency file integrated into main worktree" }
    if (!(Test-Path -LiteralPath (Join-Path $tmp "child.txt"))) { throw "Expected dependent task to run after auto-accepted dependency" }
    if (git -C $tmp branch --list "agentic/dep-task") { throw "Expected dep branch cleanup after auto-accept" }
    if (git -C $tmp branch --list "agentic/child-task") { throw "Expected child branch cleanup after auto-accept" }
    $worktreeText = ((git -C $tmp worktree list --porcelain) -join "`n") -replace '/', '\'
    if ($worktreeText -match [regex]::Escape((Join-Path $tmp ".worktrees/dep-task"))) { throw "Expected dep worktree cleanup after auto-accept" }
    if ($worktreeText -match [regex]::Escape((Join-Path $tmp ".worktrees/child-task"))) { throw "Expected child worktree cleanup after auto-accept" }

    $manual = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-manual-no-merge-" + [guid]::NewGuid().ToString("n"))
    Copy-Item -Recurse -Path $tmp -Destination $manual
    Remove-Item -Recurse -Force (Join-Path $manual ".git"), (Join-Path $manual ".worktrees"), (Join-Path $manual ".agent-runs") -ErrorAction SilentlyContinue
    git -C $manual init | Out-Null
    git -C $manual config user.email "agentic-smoke@example.test"
    git -C $manual config user.name "Agentic Smoke"
    Remove-Item -Force (Join-Path $manual "dep.txt"), (Join-Path $manual "child.txt") -ErrorAction SilentlyContinue
    $manualStatePath = Join-Path $manual "agentic.json"
    $manualState = Get-Content -Raw -LiteralPath $manualStatePath | ConvertFrom-Json
    $manualState.tasks = @($manualState.tasks | Where-Object { $_.id -eq "dep task" })
    $manualState.tasks[0].status = "pending"
    $manualState.maxIterations = 1
    $manualState | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manualStatePath -Encoding UTF8
    git -C $manual add -A
    git -C $manual commit -m "initial" | Out-Null
    Push-Location $manual
    try {
        & $ps -NoProfile -File $script --no-merge --command "& '$executor' '{prompt}'" --verifier-command "& '$verifier' '{prompt}'" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "manual no-merge run exited with $LASTEXITCODE" }
    } finally { Pop-Location }
    if (Test-Path -LiteralPath (Join-Path $manual "dep.txt")) { throw "Without auto-accept, no-merge should not integrate into main worktree" }
    if (!(git -C $manual branch --list "agentic/dep-task")) { throw "Without auto-accept, no-merge should leave branch for review" }

    Write-Output "agentic auto-accept smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
