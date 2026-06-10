#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-controls-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    @'
{"version":1,"goal":"controls smoke","phase":"execution","maxIterations":1,"checks":["test -f smoke-output.txt"],"tasks":[{"id":"task-001","title":"Create smoke output","kind":"maintenance","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["smoke-output.txt exists"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["smoke-output.txt"]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
"ok" | Set-Content -Path "smoke-output.txt" -Encoding UTF8
Write-Output "created smoke-output.txt"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    $trunk = (git -C $tmp branch --show-current)
    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --fast-verifier --agent-timeout-seconds 30 --check-timeout-seconds 30 --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "fast-verifier run failed" }
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"verifier_skipped"') { throw "Expected verifier_skipped event" }
        @'
{"version":1,"goal":"reset smoke","phase":"execution","maxIterations":1,"checks":[],"tasks":[{"id":"task-reset","title":"Reset me","kind":"implementation","workflow":"tdd","status":"needs_human","priority":1,"acceptanceCriteria":[],"validation":[],"dependsOn":[],"failureHistory":[],"reviewBranch":"agentic/task-reset","reviewWorktree":".worktrees/task-reset"}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
        git checkout -b agentic/task-reset | Out-Null
        git checkout $trunk | Out-Null
        & $ps -NoProfile -File $script --reset-task task-reset --allow-dirty
        if ($LASTEXITCODE -ne 0) { throw "reset-task failed" }
        $state = Get-Content -LiteralPath (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        if ($state.tasks[0].status -ne "needs_retry") { throw "reset-task did not mark needs_retry" }
    } finally { Pop-Location }
    Write-Output "agentic operator controls smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
