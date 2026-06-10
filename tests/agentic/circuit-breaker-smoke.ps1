#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ps = Get-AgenticSmokePowerShell
$script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"

# Two pending tasks, --max-agent-calls 1. The first executor consumes call 1; before the
# second iteration the breaker trips, stopping cleanly with budget_exhausted and marking the
# next runnable task needs_human.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-breaker-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# breaker" -Encoding UTF8
    @'
{"version":1,"goal":"breaker","phase":"execution","maxIterations":5,"checks":[],"tasks":[
{"id":"task-001","title":"First","kind":"maintenance","workflow":"tdd","status":"pending","priority":1,"acceptanceCriteria":["a.txt"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["a.txt"]},
{"id":"task-002","title":"Second","kind":"maintenance","workflow":"tdd","status":"pending","priority":2,"acceptanceCriteria":["b.txt"],"validation":[],"dependsOn":[],"failureHistory":[],"scope":["b.txt"]}
],"decisions":[],"assumptions":[],"openQuestions":[],"blockers":[],"promptPolicy":{"lessons":[]}}
'@ | Set-Content -Path (Join-Path $tmp "agentic.json") -Encoding UTF8
    # Fake agent: as executor writes the scoped file; as verifier writes a pass result.
    $fake = Join-Path $tmp "fake-agent.ps1"
    @'
param([string]$Prompt)
$content = Get-Content -LiteralPath $Prompt -Raw
if ($content -match "Write JSON only to this path: (.+)") {
    $resultPath = $Matches[1].Trim()
    $parent = Split-Path -Parent $resultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    '{ "verdict": "pass", "summary": "ok", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
}
if ($content -match "Task JSON") {
    if ($content -match '"id":\s*"task-001"') { "ok" | Set-Content -Path "a.txt" -Encoding UTF8 }
    elseif ($content -match '"id":\s*"task-002"') { "ok" | Set-Content -Path "b.txt" -Encoding UTF8 }
}
Write-Output "executor done"
'@ | Set-Content -Path $fake -Encoding UTF8
    git -C $tmp add -A; git -C $tmp commit -m initial | Out-Null
    Push-Location $tmp
    try {
        & $ps -NoProfile -File $script --tool custom --command "`"$ps`" -NoProfile -File `"$fake`" {prompt}" --max-agent-calls 1 --max-iterations 5 2>$null
        # Breaker trip exits non-zero by design.
        $events = Get-Content -LiteralPath (Join-Path $tmp ".agent-runs/events.jsonl") -Raw
        if ($events -notmatch '"type":"budget_exhausted"') { throw "Expected budget_exhausted event" }
        if ($events -notmatch "agent-call budget exhausted") { throw "Expected agent-call budget reason" }
        $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
        $statuses = @($state.tasks | ForEach-Object { $_.status })
        if (($statuses | Where-Object { $_ -eq "needs_human" }).Count -lt 1) { throw "Expected a task marked needs_human after breaker trip; got $($statuses -join ',')" }
    } finally { Pop-Location }
    Write-Output "agentic circuit breaker smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
