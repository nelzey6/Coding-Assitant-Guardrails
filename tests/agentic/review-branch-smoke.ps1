#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-review-branch-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Review branch smoke" -Encoding UTF8
    @'
{
  "version": 1,
  "goal": "Review branch before accept",
  "maxIterations": 1,
  "checks": [],
  "tasks": [
    { "id": "review task/001", "title": "Review", "kind": "implementation", "status": "pending", "workflow": "tdd", "priority": 1, "validation": [], "acceptanceCriteria": [], "dependsOn": [], "failureHistory": [] }
  ]
}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null
    $initialHead = git -C $tmp rev-parse HEAD

    $executor = Join-Path $tmp "executor.ps1"
    'param([string]$Prompt) Set-Content -Path "reviewed.txt" -Value "reviewed" -Encoding UTF8' | Set-Content -Path $executor -Encoding UTF8
    $verifier = Join-Path $tmp "verifier.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -notmatch 'Write JSON only to this path:\s*(.+)') { throw "Result path not found" }
@{ verdict = "pass"; summary = "ok"; artifacts = @() } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Matches[1].Trim() -Encoding UTF8
'@ | Set-Content -Path $verifier -Encoding UTF8
    git -C $tmp add -A
    git -C $tmp commit -m "helpers" | Out-Null
    $baseHead = git -C $tmp rev-parse HEAD

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $ps = (Get-Process -Id $PID).Path
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --review-branch --command "& '$executor' '{prompt}'" --verifier-command "& '$verifier' '{prompt}'" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally { Pop-Location }

    if ((git -C $tmp rev-parse HEAD) -ne $baseHead) { throw "Review-branch mode changed originally active branch" }
    if (Test-Path -LiteralPath (Join-Path $tmp "reviewed.txt")) { throw "Review-branch mode wrote result into main worktree before accept" }
    $reviewBranch = "agentic/review/review-task-001"
    if (!(git -C $tmp branch --list $reviewBranch)) { throw "Expected review branch $reviewBranch" }
    $state = Get-Content -Raw -LiteralPath (Join-Path $tmp "agentic.json") | ConvertFrom-Json
    $task = $state.tasks | Where-Object id -eq "review task/001" | Select-Object -First 1
    if ($task.status -ne "passed") { throw "Expected task passed, got $($task.status)" }
    if ($task.reviewBranch -ne $reviewBranch) { throw "Expected state reviewBranch $reviewBranch, got $($task.reviewBranch)" }
    Push-Location $tmp
    try {
        $status = & $ps -NoProfile -File $script --status 2>&1
    } finally { Pop-Location }
    if (($status -join "`n") -notmatch [regex]::Escape($reviewBranch)) { throw "--status did not explain review branch: $($status -join "`n")" }

    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --accept "review task/001" --merge-mode ff-only --allow-dirty
        if ($LASTEXITCODE -ne 0) { throw "accept exited with $LASTEXITCODE" }
    } finally { Pop-Location }
    if (!(Test-Path -LiteralPath (Join-Path $tmp "reviewed.txt"))) { throw "Expected reviewed.txt after accept" }
    if (git -C $tmp branch --list $reviewBranch) { throw "Expected review branch cleanup after accept" }
    $state = Get-Content -Raw -LiteralPath (Join-Path $tmp "agentic.json") | ConvertFrom-Json
    $task = $state.tasks | Where-Object id -eq "review task/001" | Select-Object -First 1
    if (![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) { throw "Expected reviewBranch cleared after accept" }
    if ([string]::IsNullOrWhiteSpace([string]$task.acceptedAt)) { throw "Expected acceptedAt after accept" }

    Write-Output "agentic review branch smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
