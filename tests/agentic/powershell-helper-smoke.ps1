#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "powershell-helper.ps1")

$ps = Get-AgenticSmokePowerShell
if ([string]::IsNullOrWhiteSpace($ps)) { throw "Expected helper to return a PowerShell executable path" }
if (!(Test-Path -LiteralPath $ps -PathType Leaf)) { throw "PowerShell executable does not exist: $ps" }

$hostPath = (Get-Process -Id $PID).Path
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
$allowed = @($hostPath)
if ($pwsh) { $allowed += $pwsh.Source }

$resolved = [System.IO.Path]::GetFullPath($ps)
$allowedResolved = $allowed | Where-Object { $_ } | ForEach-Object { [System.IO.Path]::GetFullPath($_) }
if ($resolved -notin $allowedResolved) {
    throw "Expected helper to return current host or pwsh. Got '$ps'; allowed: $($allowedResolved -join ', ')"
}

$output = & $ps -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
if ($LASTEXITCODE -ne 0) { throw "Selected PowerShell exited with $LASTEXITCODE" }
if ([string]::IsNullOrWhiteSpace(($output -join "`n"))) { throw "Selected PowerShell produced no version output" }

Write-Output "agentic PowerShell helper smoke passed: $ps"
