#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-diag-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    @'
{"version":1,"goal":"diagnose stuck loop","phase":"execution","maxIterations":1,"checks":[],"tasks":[{"id":"task-a","title":"Needs human","kind":"implementation","workflow":"tdd","status":"needs_human","priority":1,"acceptanceCriteria":[],"validation":[],"dependsOn":[],"failureHistory":[{"phase":"verifier","reason":"missing docs"}]},{"id":"task-b","title":"Retry me","kind":"implementation","workflow":"tdd","status":"needs_retry","priority":2,"acceptanceCriteria":[],"validation":[],"dependsOn":[],"failureHistory":[],"attempts":1},{"id":"task-c","title":"Blocked","kind":"implementation","workflow":"tdd","status":"pending","priority":3,"acceptanceCriteria":[],"validation":[],"dependsOn":["task-a"],"failureHistory":[]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    New-Item -ItemType Directory -Path (Join-Path $tmp ".agent-runs") | Out-Null
    '{"ts":"2026-01-01T00:00:00Z","type":"checks_failed","task":"task-b","reason":"boom"}' | Set-Content -Path (Join-Path $tmp ".agent-runs/events.jsonl") -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        $last = & $ps -NoProfile -File $script --last-failure
        if (($last -join "`n") -notmatch "checks_failed|boom") { throw "last-failure did not show latest event" }
        $why = & $ps -NoProfile -File $script --why-stuck --max-retries 2
        $whyText = $why -join "`n"
        if ($whyText -notmatch "needs_human: task-a") { throw "why-stuck missing needs_human" }
        if ($whyText -notmatch "retryable: task-b") { throw "why-stuck missing retryable" }
        if ($whyText -notmatch "blocked by dependencies: task-c") { throw "why-stuck missing dependency blocked" }
        $summary = & $ps -NoProfile -File $script --summary
        if (($summary -join "`n") -notmatch "Agentic checkpoint summary") { throw "summary missing heading" }
    } finally { Pop-Location }
    Write-Output "agentic operator diagnostics smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
