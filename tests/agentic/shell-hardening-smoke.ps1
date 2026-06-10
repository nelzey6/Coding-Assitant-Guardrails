#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

# Directly exercises Invoke-ShellCommandCapture's timeout path with commands that contain
# shell metacharacters and quotes — the case the previous hand-rolled escaping mishandled.
# The command body is written to a temp script, so metacharacters never reach an argument parser.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$src = Get-Content -LiteralPath (Join-Path $repoRoot "scripts/agentic/agentic-loop.ps1") -Raw
$m = [regex]::Match($src, "(?ms)^function Invoke-ShellCommandCapture\b.*?\n\}")
if (!$m.Success) { throw "could not extract Invoke-ShellCommandCapture" }
Invoke-Expression $m.Value

# 1. Embedded double quotes survive intact.
$out = Invoke-ShellCommandCapture 'Write-Output "alpha ""beta"" gamma"' "" 30
if ($out -notmatch "beta") { throw "embedded quotes lost: [$out]" }

# 2. Semicolons / multiple statements run as one shell body, not split into separate args.
$out2 = Invoke-ShellCommandCapture 'Write-Output one; Write-Output two' "" 30
if (($out2 -notmatch "one") -or ($out2 -notmatch "two")) { throw "statement sequence broken: [$out2]" }

# 3. Non-zero exit is surfaced as a failure including the command text.
$threw = $false
try { Invoke-ShellCommandCapture 'exit 3' "" 30 } catch { $threw = $true; if ($_.Exception.Message -notmatch "code 3") { throw "exit code not reported: $($_.Exception.Message)" } }
if (!$threw) { throw "non-zero exit did not throw" }

# 4. Metric lines pass through for downstream parsing.
$out4 = Invoke-ShellCommandCapture 'Write-Output "METRIC widget_count=5"' "" 30
if ($out4 -notmatch "METRIC widget_count=5") { throw "metric line lost: [$out4]" }

Write-Output "agentic shell hardening smoke passed"
