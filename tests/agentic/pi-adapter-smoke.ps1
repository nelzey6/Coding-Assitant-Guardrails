#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-pi-adapter-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    git -C $tmp init | Out-Null
    git -C $tmp config user.email "agentic-smoke@example.test"
    git -C $tmp config user.name "Agentic Smoke"

    Set-Content -Path (Join-Path $tmp "AGENTS.md") -Value "Smoke repo rules." -Encoding UTF8
    Set-Content -Path (Join-Path $tmp "README.md") -Value "# Smoke" -Encoding UTF8

    git -C $tmp add -A
    git -C $tmp commit -m "initial" | Out-Null

    $script = Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1"
    $piCalls = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-pi-calls-" + [guid]::NewGuid().ToString("n") + ".log")

    function global:pi {
        $piArgs = @($args)
        if ($piArgs.Count -ne 2 -or $piArgs[0] -ne "-p" -or !$piArgs[1].StartsWith("@")) {
            throw "Expected pi -p @<prompt-file>, got: $($piArgs -join ' ')"
        }
        $promptPath = $piArgs[1].Substring(1)
        if (!(Test-Path -LiteralPath $promptPath -PathType Leaf)) { throw "Prompt path does not exist: $promptPath" }
        Add-Content -LiteralPath $env:AGENTIC_PI_CALLS -Value $promptPath
        $content = Get-Content -LiteralPath $promptPath -Raw

        if ($content -match "Write planner JSON only to: (.+)") {
            $resultPath = $Matches[1].Trim()
            $transcriptPath = $null
            if ($content -match "Also write an autonomous grill transcript markdown file to: (.+)") { $transcriptPath = $Matches[1].Trim() }
            $parent = Split-Path -Parent $resultPath
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            if ($transcriptPath) { "# Autonomous Grill Transcript`n`nPi adapter smoke transcript." | Set-Content -LiteralPath $transcriptPath -Encoding UTF8 }
            @"
{
  "verdict": "planned",
  "summary": "planned pi adapter smoke task",
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "artifacts": ["grill-transcript.md"],
  "tasks": [
    {
      "id": "task-001",
      "title": "Create pi smoke output",
      "kind": "implementation",
      "workflow": "tdd",
      "status": "pending",
      "priority": 1,
      "acceptanceCriteria": ["pi-smoke-output.txt exists"],
      "validation": ["test -f pi-smoke-output.txt"],
      "dependsOn": [],
      "failureHistory": [],
      "artifacts": []
    }
  ]
}
"@ | Set-Content -LiteralPath $resultPath -Encoding UTF8
            Write-Output "pi planner wrote result"
            return
        }

        if ($content -match "Write JSON only to this path: (.+)") {
            $resultPath = $Matches[1].Trim()
            $parent = Split-Path -Parent $resultPath
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            '{ "verdict": "pass", "summary": "pi verifier passed", "issues": [], "humanGates": [], "recommendedStatus": "passed" }' | Set-Content -LiteralPath $resultPath -Encoding UTF8
            Write-Output "pi verifier wrote result"
            return
        }

        "ok" | Set-Content -Path "pi-smoke-output.txt" -Encoding UTF8
        Write-Output "pi executor created output"
    }

    $env:AGENTIC_PI_CALLS = $piCalls
    Push-Location $tmp
    try {
        & $script --tool pi --goal "Pi adapter plan smoke" --plan-only
        if ($LASTEXITCODE -ne 0) { throw "plan-only agentic-loop exited with $LASTEXITCODE" }
        git -C $tmp add -A
        git -C $tmp commit -m "planned" | Out-Null

        & $script --tool pi --max-iterations 1
        if ($LASTEXITCODE -ne 0) { throw "agentic-loop exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
        Remove-Item function:\pi -ErrorAction SilentlyContinue
        Remove-Item env:\AGENTIC_PI_CALLS -ErrorAction SilentlyContinue
    }

    $calls = @(Get-Content -LiteralPath $piCalls)
    if ($calls.Count -lt 3) { throw "Expected planner, executor, and verifier pi calls; got $($calls.Count)" }
    foreach ($call in $calls) {
        if (!(Test-Path -LiteralPath $call -PathType Leaf)) { throw "Recorded prompt path missing: $call" }
    }

    $state = Get-Content -Path (Join-Path $tmp "agentic.json") -Raw | ConvertFrom-Json
    if ($state.tasks[0].status -ne "passed") { throw "Expected task passed, got $($state.tasks[0].status)" }
    if (!(Test-Path -Path (Join-Path $tmp "pi-smoke-output.txt"))) { throw "Expected pi-smoke-output.txt after merge" }
    Write-Output "agentic pi adapter smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $piCalls -Force -ErrorAction SilentlyContinue
    }
}
