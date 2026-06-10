#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ps = Get-AgenticSmokePowerShell
$script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"

function New-Repo([string]$Tag) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-adv-smoke-$Tag-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# adv" -Encoding UTF8
    return $tmp
}

# --- Case A: high-risk implementation task, all votes pass -> 3 votes, task passes. ---
$tmp = New-Repo "pass"
try {
    @'
{"version":1,"goal":"adv","phase":"execution","maxIterations":1,"checks":["test -f out.txt"],"tasks":[{"id":"task-001","title":"Risky","kind":"implementation","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["out.txt"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["out.txt"]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    if ($content -notmatch "independent adversarial reviewers") { throw "high-risk verifier prompt missing adversarial framing" }
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    '{ "verdict": "pass", "summary": "ok", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
"ok" | Set-Content -Path "out.txt" -Encoding UTF8
Write-Output "executor done"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "unanimous-pass run should succeed" }
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"verifier_votes_started"') { throw "Expected verifier_votes_started for high-risk task" }
        $voteCount = ([regex]::Matches($events, '"type":"verifier_vote"')).Count
        if ($voteCount -ne 3) { throw "Expected 3 verifier_vote events, got $voteCount" }
        $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        if ($state.tasks[0].status -ne "passed") { throw "Expected passed, got $($state.tasks[0].status)" }
    } finally { Pop-Location }
    Write-Output "adversarial pass case: $tmp"
} finally { if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } }

# --- Case B: high-risk task, majority fail -> task not passed. ---
$tmp = New-Repo "fail"
try {
    @'
{"version":1,"goal":"adv fail","phase":"execution","maxIterations":1,"checks":["test -f out.txt"],"tasks":[{"id":"task-001","title":"Risky","kind":"implementation","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["out.txt"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["out.txt"]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    # Verifier votes fail; harness should tally a fail majority and not pass the task.
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    '{ "verdict": "fail", "summary": "refuted", "issues": ["broken"], "humanGates": [], "recommendedStatus": "needs_retry" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
"ok" | Set-Content -Path "out.txt" -Encoding UTF8
Write-Output "executor done"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1 2>$null
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"verdict":"fail"') { throw "Expected a fail verdict from the vote tally" }
        $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        if ($state.tasks[0].status -eq "passed") { throw "Majority-fail task must not pass" }
    } finally { Pop-Location }
    Write-Output "adversarial fail case: $tmp"
} finally { if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } }

Write-Output "agentic adversarial verifier smoke passed"
