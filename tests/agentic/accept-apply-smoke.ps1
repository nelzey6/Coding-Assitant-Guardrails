#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-accept-apply-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Accept apply smoke" -Encoding UTF8
    Set-Content -Path (Join-Path $tmp ".gitignore") -Value ".worktrees/" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Apply a passed no-merge task without committing",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    { "id": "task apply/001", "title": "Already passed", "status": "passed", "workflow": "tdd", "priority": 1, "dependsOn": [], "failureHistory": [] },
    { "id": "task apply/pending", "title": "Not passed", "status": "pending", "workflow": "tdd", "priority": 2, "dependsOn": [], "failureHistory": [] },
    { "id": "task apply/conflict", "title": "Conflicts", "status": "passed", "workflow": "tdd", "priority": 3, "dependsOn": [], "failureHistory": [] },
    { "id": "task apply/no-branch", "title": "Missing branch", "status": "passed", "workflow": "tdd", "priority": 4, "dependsOn": [], "failureHistory": [] }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "conflict.txt") -Value "base" -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $safeId = "task-apply-001"
    $branch = "agentic/$safeId"
    $worktreePath = Join-Path $tmp ".worktrees/$safeId"
    git -C $tmp worktree add -b $branch $worktreePath HEAD | Out-Null
    Set-Content -Path (Join-Path $worktreePath "applied.txt") -Value "applied" -Encoding UTF8
    git -C $worktreePath add -A
    git -C $worktreePath commit -m "agentic: complete task apply/001" | Out-Null

    $conflictSafeId = "task-apply-conflict"
    $conflictBranch = "agentic/$conflictSafeId"
    $conflictWorktreePath = Join-Path $tmp ".worktrees/$conflictSafeId"
    git -C $tmp worktree add -b $conflictBranch $conflictWorktreePath HEAD | Out-Null
    Set-Content -Path (Join-Path $conflictWorktreePath "conflict.txt") -Value "branch" -Encoding UTF8
    git -C $conflictWorktreePath add -A
    git -C $conflictWorktreePath commit -m "agentic: complete conflict task" | Out-Null

    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell

        Set-Content -Path (Join-Path $tmp "dirty.txt") -Value "dirty" -Encoding UTF8
        $output = & $ps -NoProfile -File $script --accept "task apply/001" --merge-mode apply 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected apply accept with dirty worktree to fail" }
        if (($output -join "`n") -notmatch "working tree is dirty") { throw "Expected dirty worktree error, got: $($output -join "`n")" }
        Remove-Item -LiteralPath (Join-Path $tmp "dirty.txt")

        & $ps -NoProfile -File $script --accept "task apply/001" --merge-mode apply
        if ($LASTEXITCODE -ne 0) { throw "apply accept exited with $LASTEXITCODE" }
        if (!(Test-Path -LiteralPath (Join-Path $tmp "applied.txt"))) { throw "Expected applied.txt after apply accept" }
        $headMessage = git -C $tmp log -1 --pretty=%s
        if ($headMessage -ne "initial") { throw "Apply mode should not create a commit; HEAD is '$headMessage'" }
        $status = git -C $tmp status --porcelain
        if (($status -join "`n") -notmatch "A  applied.txt") { throw "Expected applied.txt staged for review, got: $($status -join "`n")" }
        if (!(git -C $tmp branch --list $branch)) { throw "Apply mode should leave accepted branch for conservative cleanup" }
        git -C $tmp reset --hard HEAD | Out-Null

        $before = git -C $tmp rev-parse HEAD
        $output = & $ps -NoProfile -File $script --accept "task apply/missing" --merge-mode apply 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected missing task to fail" }
        if ($before -ne (git -C $tmp rev-parse HEAD)) { throw "Missing task modified HEAD" }
        if (($output -join "`n") -notmatch "not found") { throw "Expected missing task error, got: $($output -join "`n")" }

        $output = & $ps -NoProfile -File $script --accept "task apply/pending" --merge-mode apply 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected non-passed task to fail" }
        if (($output -join "`n") -notmatch "expected 'passed'") { throw "Expected non-passed error, got: $($output -join "`n")" }

        $output = & $ps -NoProfile -File $script --accept "task apply/no-branch" --merge-mode apply 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected missing branch task to fail" }
        if (($output -join "`n") -notmatch "branch 'agentic/task-apply-no-branch' was not found") { throw "Expected missing branch error, got: $($output -join "`n")" }

        Set-Content -Path (Join-Path $tmp "conflict.txt") -Value "main" -Encoding UTF8
        git -C $tmp add -A
        git -C $tmp commit -m "main conflict" | Out-Null
        $output = & $ps -NoProfile -File $script --accept "task apply/conflict" --merge-mode apply 2>&1
        if ($LASTEXITCODE -eq 0) { throw "Expected conflict apply to fail" }
        if (($output -join "`n") -notmatch "apply/no-commit") { throw "Expected clear apply conflict error, got: $($output -join "`n")" }
        try { git -C $tmp cherry-pick --abort 2>$null } catch { }
    } finally { Pop-Location }

    Write-Output "agentic accept apply smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
