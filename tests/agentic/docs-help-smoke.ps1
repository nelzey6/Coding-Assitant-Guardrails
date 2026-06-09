#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$readmePath = Join-Path $repoRoot "scripts/agentic/README.md"
$loopPath = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"

$readme = Get-Content -LiteralPath $readmePath -Raw
$loop = Get-Content -LiteralPath $loopPath -Raw

$requiredReadmeTerms = @(
    "--retry <task-id>",
    "--max-retries <n>",
    "automatic retries",
    "retry budget",
    "validation discovery",
    "task.validation",
    "pwsh -File",
    "--review-branch",
    "--accept <task-id>",
    "--auto-accept-passed",
    "--doctor",
    "stale review metadata",
    "missing review branches/worktrees"
)
foreach ($term in $requiredReadmeTerms) {
    if ($readme -notmatch [regex]::Escape($term)) { throw "README missing required agentic docs term: $term" }
}

$requiredHelpTerms = @(
    "--retry <task-id>",
    "--max-retries <n>",
    "--review-branch",
    "--accept <task-id>",
    "--auto-accept-passed",
    "--merge-mode <mode>",
    "--doctor"
)
foreach ($term in $requiredHelpTerms) {
    if ($loop -notmatch [regex]::Escape($term)) { throw "Show-Usage missing required option: $term" }
}

$requiredSmokeCommands = @(
    "pwsh -File tests/agentic/retry-smoke.ps1",
    "pwsh -File tests/agentic/review-branch-smoke.ps1",
    "pwsh -File tests/agentic/validation-discovery-smoke.ps1",
    "pwsh -File tests/agentic/doctor-smoke.ps1"
)
foreach ($command in $requiredSmokeCommands) {
    if ($readme -notmatch [regex]::Escape($command)) { throw "README smoke section missing: $command" }
}

if ($readme -match "powershell\.exe" -and $readme -notmatch "legacy Windows PowerShell") {
    throw "README should prefer pwsh -File and mention powershell.exe only as a legacy fallback"
}

Write-Output "Agentic docs/help smoke passed."
