#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ps = Get-AgenticSmokePowerShell
$script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"

# A high-risk task (kind=implementation) requested fast-verifier. The guard must DENY the
# skip, emit verifier_skip_denied, and run the full verifier instead.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-fvguard-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# fv guard" -Encoding UTF8
    @'
{"version":1,"goal":"fv guard","phase":"execution","maxIterations":1,"checks":["test -f out.txt"],"tasks":[{"id":"task-001","title":"Risky change","kind":"implementation","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["out.txt exists"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["out.txt"]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    '{ "verdict": "pass", "summary": "full verifier ran", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Write-Output "verifier ran"
    exit 0
}
"ok" | Set-Content -Path "out.txt" -Encoding UTF8
Write-Output "created out.txt"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --fast-verifier --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "guarded run should still pass via the full verifier" }
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"verifier_skip_denied"') { throw "Expected verifier_skip_denied for high-risk task" }
        if ($events -match '"type":"verifier_skipped"') { throw "verifier must NOT be skipped for a high-risk task" }
        if ($events -notmatch '"type":"verifier_finished"') { throw "Expected the full verifier to run (verifier_finished)" }
    } finally { Pop-Location }
    Write-Output "agentic fast-verifier guard smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
