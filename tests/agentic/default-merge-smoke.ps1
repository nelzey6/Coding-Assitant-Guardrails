#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-default-merge-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    git -C $tmp branch -m main

    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Default merge smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Default pass behavior merges into the active branch",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    {
      "id": "default merge/001",
      "title": "Create default merge proof",
      "kind": "implementation",
      "status": "pending",
      "workflow": "tdd",
      "priority": 1,
      "validation": ["test -f default-merged.txt"],
      "acceptanceCriteria": ["default-merged.txt exists on the active branch after pass"],
      "dependsOn": [],
      "failureHistory": []
    }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    $executor = Join-Path $tmp "executor.ps1"
    @'
param([string]$Prompt)
Set-Content -Path "default-merged.txt" -Value "merged by default" -Encoding UTF8
Write-Output "created default-merged.txt"
'@ | Set-Content -Path $executor -Encoding UTF8

    $verifier = Join-Path $tmp "verifier.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -notmatch 'Write JSON only to this path:\s*(.+)') { throw "Result path not found" }
@{ verdict = "pass"; summary = "default merge verifier passed"; issues = @(); humanGates = @(); recommendedStatus = "passed" } |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $Matches[1].Trim() -Encoding UTF8
Write-Output "default merge verifier passed"
'@ | Set-Content -Path $verifier -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null
    $baseHead = git -C $tmp rev-parse HEAD
    $activeBranch = git -C $tmp branch --show-current
    if ($activeBranch -ne "main") { throw "Expected active branch main before smoke, got $activeBranch" }

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = (Get-Process -Id $PID).Path
    Push-Location $tmp
    try {
        $previousGitRedirectStderr = $env:GIT_REDIRECT_STDERR
        $env:GIT_REDIRECT_STDERR = "2>&1"
        try {
            & $ps -NoProfile -File $script --command "& '$executor' '{prompt}'" --verifier-command "& '$verifier' '{prompt}'" --max-iterations 1
            if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
        } finally {
            $env:GIT_REDIRECT_STDERR = $previousGitRedirectStderr
        }
    } finally { Pop-Location }

    $activeBranchAfter = git -C $tmp branch --show-current
    if ($activeBranchAfter -ne "main") { throw "Expected active branch to remain main, got $activeBranchAfter" }
    if ((git -C $tmp rev-parse HEAD) -eq $baseHead) { throw "Expected default pass to advance the active branch" }
    if (!(Test-Path -LiteralPath (Join-Path $tmp "default-merged.txt"))) { throw "Expected default-merged.txt in active worktree after default merge" }

    $taskBranch = "agentic/default-merge-001"
    if (!(git -C $tmp branch --list $taskBranch)) { throw "Expected task branch $taskBranch" }
    git -C $tmp merge-base --is-ancestor $taskBranch HEAD
    if ($LASTEXITCODE -ne 0) { throw "Expected active branch HEAD to contain $taskBranch by default" }

    $state = Get-Content -Raw -LiteralPath (Join-Path $tmp "agentic.json") | ConvertFrom-Json
    $task = $state.tasks | Where-Object id -eq "default merge/001" | Select-Object -First 1
    if ($task.status -ne "passed") { throw "Expected task passed, got $($task.status)" }
    if (![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) { throw "Default merge should not set reviewBranch" }
    $checksLog = Join-Path (Join-Path $tmp $task.lastRunDir) "checks.log"
    if (!(Test-Path -LiteralPath $checksLog)) { throw "Expected checks.log artifact" }

    Write-Output "agentic default merge smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
