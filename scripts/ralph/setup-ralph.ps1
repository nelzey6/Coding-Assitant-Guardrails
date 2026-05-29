param(
    [Parameter(Mandatory = $true)]
    [string]$SkillsRepo,
    [ValidateSet("Codex", "Claude", "Both")]
    [string]$Tool = "Both"
)

$ErrorActionPreference = "Stop"

$source = Join-Path $SkillsRepo "scripts/ralph/ralph.ps1"
if (!(Test-Path $source)) {
    throw "Ralph script not found: $source"
}

$targets = @()
if ($Tool -eq "Claude" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".claude/skills/ralph-prd/scripts/ralph.ps1"
}
if ($Tool -eq "Codex" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".codex/skills/ralph-prd/scripts/ralph.ps1"
}

foreach ($target in $targets) {
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host "Installed Ralph harness to $target"
}

if ($targets.Count -eq 0) {
    Write-Host "No Ralph target selected for tool '$Tool'"
    exit 0
}

# Prefer Claude's installed copy when present because Claude is the primary Ralph adapter;
# otherwise use the first installed target.
$preferred = $targets | Where-Object { $_ -like "*\.claude\*" -or $_ -like "*/.claude/*" } | Select-Object -First 1
if (!$preferred) { $preferred = $targets[0] }

$binDir = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdShim = Join-Path $binDir "ralph.cmd"
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
Write-Host "Installed Ralph Windows shim to $cmdShim"

$psShim = Join-Path $binDir "ralph.ps1"
@"
`$script = "$preferred"
if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    & pwsh -NoProfile -File `$script @args
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `$script @args
}
exit `$LASTEXITCODE
"@ | Set-Content -Path $psShim -Encoding UTF8
Write-Host "Installed Ralph PowerShell shim to $psShim"

# Git Bash/MSYS on Windows commonly has ~/bin on PATH. This shim also works on Unix
# if this installer is run under PowerShell Core there.
$shShim = Join-Path $binDir "ralph"
$shTarget = $preferred.Replace("\", "/")
@"
#!/usr/bin/env sh
exec pwsh -NoProfile -File "$shTarget" "`$@"
"@ | Set-Content -Path $shShim -Encoding UTF8
Write-Host "Installed Ralph shell shim to $shShim"

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

Write-Host "Ralph command installed. Run: ralph --help"
