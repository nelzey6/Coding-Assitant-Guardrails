#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-finalize-docs-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "PROJECT.md") -Value "# Project`n" -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "CONTEXT.md") -Value "# Context`n" -Encoding UTF8
    @'
{"version":1,"goal":"finalize docs smoke","phase":"execution","maxIterations":1,"checks":["test -f smoke-output.txt"],"tasks":[{"id":"task-001","title":"Create smoke output","kind":"implementation","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["smoke-output.txt exists"],"validation":[],"dependsOn":[],"failureHistory":[]}],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    $resultPath = $Matches[1].Trim()
    '{"verdict":"pass","summary":"ok","issues":[],"humanGates":[],"recommendedStatus":"passed","artifacts":[]}' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
if ($content -match "You are finalizing a completed agentic loop run") {
    Add-Content -LiteralPath "PROJECT.md" -Value "- Finalized docs smoke technical fact."
    exit 0
}
"ok" | Set-Content -Path "smoke-output.txt" -Encoding UTF8
New-Item -ItemType Directory -Force -Path "docs" | Out-Null
"# Durable guide" | Set-Content -Path "docs/guide.md" -Encoding UTF8
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
        $ps = Get-AgenticSmokePowerShell
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally { Pop-Location }
    if ((Get-Content -LiteralPath (Join-Path $tmp "PROJECT.md") -Raw) -notmatch "Finalized docs smoke") { throw "PROJECT.md was not finalized" }
    $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
    if ($events -notmatch '"type":"finalize_docs_started"') { throw "Expected finalize_docs_started event" }
    if ($events -notmatch '"type":"finalize_docs_finished"') { throw "Expected finalize_docs_finished event" }
    $summary = Get-ChildItem -Path (Join-Path $tmp ".agent-runs") -Recurse -Filter final-summary.md | Select-Object -First 1
    if ($null -ne $summary) { throw "Routine final-summary.md should not be created" }
    Write-Output "agentic finalize-docs smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
