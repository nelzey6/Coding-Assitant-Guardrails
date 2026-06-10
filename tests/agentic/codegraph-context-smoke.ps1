#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agentic-codegraph-smoke-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $helper = Join-Path $repoRoot "scripts/context/codegraph-context.ps1"
    $fakeBin = Join-Path $tmp "bin"
    New-Item -ItemType Directory -Path $fakeBin | Out-Null
    $fakeCodegraph = Join-Path $fakeBin "codegraph.cmd"
    @'
@echo off
if "%1"=="files" (
  echo FAKE_CODEGRAPH_FILES %*
  exit /b 0
)
if "%1"=="context" (
  echo FAKE_CODEGRAPH_CONTEXT %*
  exit /b 0
)
if "%1"=="status" (
  echo FAKE_CODEGRAPH_STATUS %*
  exit /b 0
)
echo FAKE_CODEGRAPH_OTHER %*
exit /b 0
'@ | Set-Content -LiteralPath $fakeCodegraph -Encoding ASCII

    $oldPath = $env:Path
    try {
        $env:Path = "$fakeBin;$oldPath"
        $out = Join-Path $tmp "codegraph.md"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Output $out -WorkingDirectory $tmp | Out-Null
        $content = Get-Content -LiteralPath $out -Raw
        if ($content -notmatch "FAKE_CODEGRAPH_FILES") { throw "Expected fake files output" }
        if ($content -notmatch "FAKE_CODEGRAPH_CONTEXT") { throw "Expected fake context output" }
        if ($content -notmatch "FAKE_CODEGRAPH_STATUS") { throw "Expected fake status output" }
    } finally {
        $env:Path = $oldPath
    }

    Write-Output "agentic codegraph context smoke passed: $tmp"
} finally {
    if ($env:AGENTIC_KEEP_SMOKE -ne "1") { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
