#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$tests = @(
    "smoke.ps1",
    "plan-only-smoke.ps1",
    "dependency-smoke.ps1",
    "status-dirty-smoke.ps1",
    "pi-adapter-smoke.ps1",
    "accept-smoke.ps1",
    "validation-checks-smoke.ps1",
    "validation-discovery-smoke.ps1",
    "auto-accept-smoke.ps1",
    "accept-apply-smoke.ps1",
    "retry-smoke.ps1",
    "review-branch-smoke.ps1",
    "doctor-smoke.ps1",
    "operator-diagnostics-smoke.ps1",
    "operator-controls-smoke.ps1",
    "finalize-docs-smoke.ps1",
    "codegraph-context-smoke.ps1",
    "docs-help-smoke.ps1"
)

foreach ($test in $tests) {
    $path = Join-Path $PSScriptRoot $test
    Write-Host "=== $test ==="
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
    if ($LASTEXITCODE -ne 0) { throw "$test failed with exit code $LASTEXITCODE" }
}

Write-Output "all agentic smoke tests passed"
