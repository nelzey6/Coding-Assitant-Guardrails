#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-status-dirty-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Status dirty smoke",
  "phase": "executing",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    {
      "id": "task-001",
      "title": "Smoke task",
      "kind": "implementation",
      "workflow": "tdd",
      "status": "pending",
      "priority": 1,
      "acceptanceCriteria": [],
      "validation": [],
      "dependsOn": [],
      "failureHistory": [],
      "artifacts": []
    }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    Add-Content -Path (Join-Path $tmp "README.md") -Value "dirty tracked change"
    Set-Content -Path (Join-Path $tmp "untracked.txt") -Value "dirty untracked change" -Encoding UTF8

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = Get-AgenticSmokePowerShell

    Push-Location $tmp
    try {
        $statusOutput = & $ps -NoProfile -File $script --status 2>&1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop --status exited with $LASTEXITCODE`: $($statusOutput -join "`n")" }
        $statusText = $statusOutput -join "`n"
        if ($statusText -notmatch "Goal: Status dirty smoke") { throw "Status output did not include goal: $statusText" }
        if ($statusText -notmatch "task-001") { throw "Status output did not include task summary: $statusText" }

        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $normalOutput = & $ps -NoProfile -File $script --tool custom --command "exit 0" --max-iterations 1 2>&1
        $normalExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        if ($normalExitCode -eq 0) { throw "Normal execution unexpectedly succeeded with dirty worktree: $($normalOutput -join "`n")" }
        if (($normalOutput -join "`n") -notmatch "Working tree is dirty") { throw "Normal execution did not report dirty worktree: $($normalOutput -join "`n")" }
    } finally {
        Pop-Location
    }

    Write-Output "agentic status dirty smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
