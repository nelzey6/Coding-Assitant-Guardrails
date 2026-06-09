param(
    [Parameter(Mandatory = $true)]
    [string]$SkillsRepo,
    [ValidateSet("Codex", "Claude", "Both")]
    [string]$Tool = "Both"
)

$ErrorActionPreference = "Stop"

$source = Join-Path $SkillsRepo "scripts\agentic\agentic-loop.ps1"
if (!(Test-Path $source)) {
    throw "Agentic loop script not found: $source"
}

$targets = @()
if ($Tool -eq "Claude" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".claude\skills\agentic-loop\scripts\agentic-loop.ps1"
}
if ($Tool -eq "Codex" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".codex\skills\agentic-loop\scripts\agentic-loop.ps1"
}

foreach ($target in $targets) {
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host "Installed agentic loop harness to $target"
}

if ($targets.Count -eq 0) {
    Write-Host "No agentic loop target selected for tool '$Tool'"
    exit 0
}

$preferred = $targets | Where-Object { $_ -like "*\.claude\*" -or $_ -like "*/.claude/*" } | Select-Object -First 1
if (!$preferred) { $preferred = $targets[0] }

$binDir = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdShim = Join-Path $binDir "agentic-loop.cmd"
@"
@echo off
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -File "$preferred" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$preferred" %*
)
exit /b %errorlevel%
"@ | Set-Content -Path $cmdShim -Encoding ASCII
Write-Host "Installed agentic-loop Windows shim to $cmdShim"

$psShim = Join-Path $binDir "agentic-loop.ps1"
@"
`$script = "$preferred"
if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    & pwsh -NoProfile -File `$script @args
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `$script @args
}
exit `$LASTEXITCODE
"@ | Set-Content -Path $psShim -Encoding UTF8
Write-Host "Installed agentic-loop PowerShell shim to $psShim"

$shShim = Join-Path $binDir "agentic-loop"
$shTarget = $preferred.Replace("\", "/")
@"
#!/usr/bin/env sh
if command -v pwsh >/dev/null 2>&1; then
  exec pwsh -NoProfile -File "$shTarget" "`$@"
elif command -v powershell.exe >/dev/null 2>&1; then
  exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$shTarget" "`$@"
else
  echo "agentic-loop requires pwsh or powershell.exe on PATH" >&2
  exit 127
fi
"@ | Set-Content -Path $shShim -Encoding ASCII
Write-Host "Installed agentic-loop shell shim to $shShim"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = @()
if (![string]::IsNullOrWhiteSpace($userPath)) { $pathParts = $userPath -split ';' }
$binAlreadyOnUserPath = $pathParts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
if (!$binAlreadyOnUserPath) {
    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "Added $binDir to the user PATH. Open a new terminal for PATH changes to apply."
}

$processPathParts = $env:Path -split ';'
$binAlreadyOnProcessPath = $processPathParts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
if (!$binAlreadyOnProcessPath) {
    $env:Path = "$env:Path;$binDir"
}

Write-Host "agentic-loop command installed. Run: agentic-loop --help"
