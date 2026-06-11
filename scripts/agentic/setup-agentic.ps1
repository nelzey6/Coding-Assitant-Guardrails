param(
    [Parameter(Mandatory = $true)]
    [string]$SkillsRepo,
    [ValidateSet("Codex", "Claude", "Both")]
    [string]$Tool = "Both"
)

$ErrorActionPreference = "Stop"

$SkillsRepo = Resolve-Path $SkillsRepo

# Verify the TS runner exists
$agentLoopDir = Join-Path $SkillsRepo "tools\agent-loop"
$agentIndexTs  = Join-Path $agentLoopDir "src\index.ts"
$tsxCli        = Join-Path $agentLoopDir "node_modules\tsx\dist\cli.mjs"

if (!(Test-Path $agentIndexTs)) {
    throw "TS agent-loop entry point not found: $agentIndexTs"
}
if (!(Test-Path $tsxCli)) {
    throw "tsx not found at $tsxCli - run 'npm install' inside $agentLoopDir first."
}

# Verify node >= 20
$nodeVersion = & node --version 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "node is not on PATH. Install Node.js >= 20 before running setup."
}
$nodeMajor = [int]($nodeVersion -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 20) {
    throw "node $nodeVersion is too old. agentic-loop requires Node.js >= 20."
}
Write-Host "node $nodeVersion detected."

# Optionally install the CodeGraph context helper
$codeGraphHelper = Join-Path $SkillsRepo "scripts\context\codegraph-context.ps1"

$targets = @()
if ($Tool -eq "Claude" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".claude\skills\agentic-loop"
}
if ($Tool -eq "Codex" -or $Tool -eq "Both") {
    $targets += Join-Path $env:USERPROFILE ".codex\skills\agentic-loop"
}

foreach ($targetDir in $targets) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    # Write a small redirect file so older skill-lookup code can still find this dir
    Set-Content -Path (Join-Path $targetDir "AGENT_LOOP_LOCATION") -Value $agentLoopDir -Encoding UTF8
    Write-Host "Registered agentic-loop location at $targetDir"
    if (Test-Path -LiteralPath $codeGraphHelper) {
        $contextDir = Join-Path $targetDir "context"
        New-Item -ItemType Directory -Force -Path $contextDir | Out-Null
        Copy-Item -LiteralPath $codeGraphHelper -Destination (Join-Path $contextDir "codegraph-context.ps1") -Force
        Write-Host "Installed CodeGraph context helper to $contextDir"
    }
}

if ($targets.Count -eq 0) {
    Write-Host "No agentic-loop target selected for tool '$Tool'"
    exit 0
}

$nodePath  = (Get-Command node).Source
$tsxCliFwd = $tsxCli.Replace("\", "/")
$indexFwd  = $agentIndexTs.Replace("\", "/")

$binDir = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Windows .cmd shim
$cmdShim = Join-Path $binDir "agentic-loop.cmd"
@"
@echo off
"$nodePath" "$tsxCliFwd" "$indexFwd" %*
exit /b %errorlevel%
"@ | Set-Content -Path $cmdShim -Encoding ASCII
Write-Host "Installed agentic-loop Windows shim to $cmdShim"

# PowerShell shim
$psShim = Join-Path $binDir "agentic-loop.ps1"
@"
& "$nodePath" "$tsxCliFwd" "$indexFwd" @args
exit `$LASTEXITCODE
"@ | Set-Content -Path $psShim -Encoding UTF8
Write-Host "Installed agentic-loop PowerShell shim to $psShim"

# POSIX shell shim
$shShim = Join-Path $binDir "agentic-loop"
@"
#!/usr/bin/env sh
exec "$nodePath" "$tsxCliFwd" "$indexFwd" "`$@"
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

Write-Host "agentic-loop installed (TS runner). Run: agentic-loop --help"
