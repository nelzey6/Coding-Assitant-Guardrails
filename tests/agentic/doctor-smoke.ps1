#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-doctor-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    git -C $tmp config core.autocrlf false
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Doctor smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Diagnose stale review state",
  "phase": "executing",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    {
      "id": "stale-review/001",
      "title": "Stale review metadata",
      "kind": "implementation",
      "status": "passed",
      "workflow": "tdd",
      "priority": 1,
      "validation": [],
      "acceptanceCriteria": [],
      "dependsOn": [],
      "failureHistory": [],
      "reviewBranch": "agentic/review/missing-branch",
      "reviewWorktree": ".worktrees/missing-worktree"
    }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null
    $beforeState = Get-Content -LiteralPath (Join-Path $tmp "agentic.json") -Raw
    $beforeHead = git -C $tmp rev-parse HEAD

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = Get-AgenticSmokePowerShell
    Push-Location $tmp
    try {
        $output = & $ps -NoProfile -File $script --doctor 2>&1
        $code = $LASTEXITCODE
    } finally { Pop-Location }

    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($code -ne 1) { throw "Expected --doctor exit code 1 for findings, got $code. Output:`n$text" }
    if ($text -notmatch "Doctor found 2 issue") { throw "Doctor summary missing issue count. Output:`n$text" }
    if ($text -notmatch [regex]::Escape("stale-review/001")) { throw "Doctor output missing task id. Output:`n$text" }
    if ($text -notmatch [regex]::Escape("review branch missing: agentic/review/missing-branch")) { throw "Doctor output missing branch diagnostic. Output:`n$text" }
    if ($text -notmatch [regex]::Escape("review worktree missing: .worktrees/missing-worktree")) { throw "Doctor output missing worktree diagnostic. Output:`n$text" }

    $afterState = Get-Content -LiteralPath (Join-Path $tmp "agentic.json") -Raw
    if ($afterState -ne $beforeState) { throw "--doctor mutated agentic.json" }
    if ((git -C $tmp rev-parse HEAD) -ne $beforeHead) { throw "--doctor changed HEAD" }
    if (git -C $tmp status --porcelain) { throw "--doctor dirtied working tree" }

    $currentBranch = git -C $tmp branch --show-current
    Set-Content -Path (Join-Path $tmp "agentic.json") -Value ($beforeState -replace 'agentic/review/missing-branch', $currentBranch -replace '\.worktrees/missing-worktree', '.') -Encoding UTF8
    git -C $tmp add agentic.json
    git -C $tmp commit -m "healthy state" | Out-Null
    Push-Location $tmp
    try {
        $healthyOutput = & $ps -NoProfile -File $script --doctor 2>&1
        $healthyCode = $LASTEXITCODE
    } finally { Pop-Location }
    if ($healthyCode -ne 0) { throw "Expected --doctor exit code 0 for healthy state, got $healthyCode. Output:`n$(($healthyOutput | ForEach-Object { [string]$_ }) -join "`n")" }

    Write-Output "agentic doctor smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
