#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-state-normalization-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    git -C $tmp config core.autocrlf false

    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    @'
{
  "goal": "State normalization smoke",
  "tasks": [
    {
      "id": "task-001",
      "title": "Minimal hand-written task"
    }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = (Get-Process -Id $PID).Path

    Push-Location $tmp
    try {
        $statusOutput = & $ps -NoProfile -File $script --status 2>&1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop --status exited with $LASTEXITCODE`: $($statusOutput -join "`n")" }
        $statusText = $statusOutput -join "`n"
        if ($statusText -notmatch "Goal: State normalization smoke") { throw "Status output did not include goal: $statusText" }
        if ($statusText -notmatch "pending\s+task-001\s+tdd\s+Minimal hand-written task") { throw "Status output did not include normalized task defaults: $statusText" }
        if ($statusText -notmatch "Next runnable: task-001") { throw "Status output did not find the minimal task runnable: $statusText" }
    } finally {
        Pop-Location
    }

    Write-Output "agentic state normalization smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
