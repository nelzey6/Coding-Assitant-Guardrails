#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

# Smoke-test the Ralph loop without invoking a real coding agent.
# It creates a temporary git repo, feeds Ralph a five-story prd.json, and uses a
# fake custom agent that makes one expected file change per iteration.

function Require-Command([string]$Name) {
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ralphScript = Join-Path $rootDir "scripts/ralph/ralph.ps1"
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-smoke-" + [System.Guid]::NewGuid().ToString("N"))

Require-Command git

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
    Set-Location $tmpDir
    git init -q
    if ($LASTEXITCODE -ne 0) { throw "git init failed" }
    git config user.email "ralph-smoke@example.test"
    git config user.name "Ralph Smoke Test"

    @'
{
  "title": "Ralph smoke test",
  "maxIterations": 5,
  "userStories": [
    {
      "id": "story-001",
      "title": "Write hello file 1",
      "priority": 1,
      "passes": false,
      "goal": "Create example-001.txt containing hello from story-001",
      "acceptanceCriteria": ["example-001.txt contains hello from story-001"],
      "validation": ["Select-String -Quiet 'hello from story-001' example-001.txt"],
      "outOfScope": [],
      "dependsOn": []
    },
    {
      "id": "story-002",
      "title": "Write hello file 2",
      "priority": 2,
      "passes": false,
      "goal": "Create example-002.txt containing hello from story-002",
      "acceptanceCriteria": ["example-002.txt contains hello from story-002"],
      "validation": ["Select-String -Quiet 'hello from story-002' example-002.txt"],
      "outOfScope": [],
      "dependsOn": []
    },
    {
      "id": "story-003",
      "title": "Write hello file 3",
      "priority": 3,
      "passes": false,
      "goal": "Create example-003.txt containing hello from story-003",
      "acceptanceCriteria": ["example-003.txt contains hello from story-003"],
      "validation": ["Select-String -Quiet 'hello from story-003' example-003.txt"],
      "outOfScope": [],
      "dependsOn": []
    },
    {
      "id": "story-004",
      "title": "Write hello file 4",
      "priority": 4,
      "passes": false,
      "goal": "Create example-004.txt containing hello from story-004",
      "acceptanceCriteria": ["example-004.txt contains hello from story-004"],
      "validation": ["Select-String -Quiet 'hello from story-004' example-004.txt"],
      "outOfScope": [],
      "dependsOn": []
    },
    {
      "id": "story-005",
      "title": "Write hello file 5",
      "priority": 5,
      "passes": false,
      "goal": "Create example-005.txt containing hello from story-005",
      "acceptanceCriteria": ["example-005.txt contains hello from story-005"],
      "validation": ["Select-String -Quiet 'hello from story-005' example-005.txt"],
      "outOfScope": [],
      "dependsOn": []
    }
  ]
}
'@ | Set-Content -Path prd.json -Encoding UTF8

    git add prd.json
    git commit -qm "seed prd"

    @'
param([string]$PromptFile)
$ErrorActionPreference = "Stop"
$content = Get-Content -LiteralPath $PromptFile -Raw
if ($content -notmatch "Do not mark the story as passing yourself") { throw "prompt missing harness rule" }
if ($content -notmatch "story-00[1-5]") { throw "prompt missing story id" }
$storyId = $Matches[0]
$number = $storyId.Substring("story-".Length)
Set-Content -Path "example-$number.txt" -Value "hello from $storyId" -Encoding UTF8
'@ | Set-Content -Path fake-agent.ps1 -Encoding UTF8

    git add fake-agent.ps1
    git commit -qm "add fake agent"

    & $ralphScript `
        --tool custom `
        --command 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./fake-agent.ps1 {prompt}' `
        --checks 'foreach ($n in "001","002","003","004","005") { if (Test-Path "example-$n.txt") { Select-String -Quiet "hello from story-$n" "example-$n.txt" | Out-Null; if (!$?) { exit 1 } } }' `
        --no-commit
    if ($LASTEXITCODE -ne 0) { throw "Ralph smoke run failed" }

    foreach ($n in "001", "002", "003", "004", "005") {
        if (!(Test-Path "example-$n.txt")) { throw "Missing example-$n.txt" }
        if (!(Select-String -Quiet "hello from story-$n" "example-$n.txt")) { throw "Wrong content in example-$n.txt" }
    }
    if (!(Test-Path progress.txt)) { throw "Missing progress.txt" }
    if (((Select-String -Pattern 'External checks passed' -Path progress.txt).Count) -ne 5) { throw "Expected 5 progress entries" }
    $state = Get-Content -LiteralPath prd.json -Raw | ConvertFrom-Json
    $passedCount = @($state.userStories | Where-Object { $_.passes -eq $true }).Count
    if ($passedCount -ne 5) { throw "Expected 5 passed stories" }

    $completion = & $ralphScript `
        --tool custom `
        --command 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./fake-agent.ps1 {prompt}' `
        --max-iterations 1 `
        --no-commit `
        --allow-dirty
    if (($completion -join "`n") -notmatch '<promise>COMPLETE</promise>') { throw "Second run did not report completion" }

    Write-Host "Ralph smoke test passed"
} finally {
    Set-Location $rootDir
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
