#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-accept-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Accept smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Accept a passed no-merge task",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    {
      "id": "task accept/001",
      "title": "Already passed",
      "status": "passed",
      "workflow": "tdd",
      "priority": 1,
      "dependsOn": [],
      "failureHistory": []
    },
    {
      "id": "task accept/pending",
      "title": "Not passed yet",
      "status": "pending",
      "workflow": "tdd",
      "priority": 2,
      "dependsOn": [],
      "failureHistory": []
    },
    {
      "id": "task accept/diverged",
      "title": "Passed but not fast-forwardable",
      "status": "passed",
      "workflow": "tdd",
      "priority": 3,
      "dependsOn": [],
      "failureHistory": []
    }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $safeId = "task-accept-001"
    $branch = "agentic/$safeId"
    $worktreePath = Join-Path $tmp ".worktrees/$safeId"
    git -C $tmp worktree add -b $branch $worktreePath HEAD | Out-Null
    Set-Content -Path (Join-Path $worktreePath "accepted.txt") -Value "accepted" -Encoding UTF8
    git -C $worktreePath add -A
    git -C $worktreePath commit -m "agentic: complete task accept/001" | Out-Null

    $divergedSafeId = "task-accept-diverged"
    $divergedBranch = "agentic/$divergedSafeId"
    $divergedWorktreePath = Join-Path $tmp ".worktrees/$divergedSafeId"
    git -C $tmp worktree add -b $divergedBranch $divergedWorktreePath HEAD | Out-Null
    Set-Content -Path (Join-Path $divergedWorktreePath "diverged.txt") -Value "diverged" -Encoding UTF8
    git -C $divergedWorktreePath add -A
    git -C $divergedWorktreePath commit -m "agentic: complete diverged task" | Out-Null
    Set-Content -Path (Join-Path $tmp "main-only.txt") -Value "main" -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "main diverges from accept branch" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = (Get-Process -Id $PID).Path
        $beforeFailedAccept = git -C $tmp rev-parse HEAD
        $failedOutput = & $ps -NoProfile -File $script --accept "task accept/diverged" --merge-mode ff-only 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected diverged ff-only accept to fail" }
        $afterFailedAccept = git -C $tmp rev-parse HEAD
        if ($beforeFailedAccept -ne $afterFailedAccept) { throw "Failed accept modified HEAD" }
        if (!(git -C $tmp branch --list $divergedBranch)) { throw "Failed accept deleted recovery branch" }
        $failedWorktrees = git -C $tmp worktree list --porcelain
        $failedWorktreeText = (($failedWorktrees -join "`n") -replace '/', '\')
        if ($failedWorktreeText -notmatch [regex]::Escape($divergedWorktreePath)) { throw "Failed accept removed recovery worktree" }
        if (($failedOutput -join "`n") -notmatch "git merge --ff-only") { throw "Expected failing git operation in error, got: $($failedOutput -join "`n")" }

        & $ps -NoProfile -File $script --accept "task accept/001" --merge-mode cherry-pick
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop --accept exited with $LASTEXITCODE" }
    } finally { Pop-Location }

    if (!(Test-Path -LiteralPath (Join-Path $tmp "accepted.txt"))) { throw "Expected accepted.txt after accept" }
    $branches = git -C $tmp branch --list $branch
    if ($branches) { throw "Expected accepted branch to be deleted" }
    $worktrees = git -C $tmp worktree list --porcelain
    $worktreeText = (($worktrees -join "`n") -replace '/', '\')
    if ($worktreeText -match [regex]::Escape($worktreePath)) { throw "Expected accepted worktree to be removed" }

    Push-Location $tmp
    try {
        $before = git -C $tmp rev-parse HEAD
        $output = & $ps -NoProfile -File $script --accept "missing-task" 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected missing task accept to fail" }
        $after = git -C $tmp rev-parse HEAD
        if ($before -ne $after) { throw "Missing task accept modified HEAD" }
        if (($output -join "`n") -notmatch "not found") { throw "Expected clear missing task error, got: $($output -join "`n")" }

        $before = git -C $tmp rev-parse HEAD
        $output = & $ps -NoProfile -File $script --accept "task accept/pending" 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected pending task accept to fail" }
        $after = git -C $tmp rev-parse HEAD
        if ($before -ne $after) { throw "Pending task accept modified HEAD" }
        if (($output -join "`n") -notmatch "expected 'passed'") { throw "Expected clear pending task error, got: $($output -join "`n")" }

        $output = & $ps -NoProfile -File $script --accept 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected accept without task id to fail" }
        if (($output -join "`n") -notmatch "Missing value for --accept") { throw "Expected clear missing --accept value error, got: $($output -join "`n")" }
    } finally { Pop-Location }

    Write-Output "agentic accept smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
