param(
    [string]$Output = ".agent-runs/codegraph.md",
    [string]$WorkingDirectory = ".",
    [string]$Command = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
$resolvedWorkingDirectory = Resolve-Path -LiteralPath $WorkingDirectory
$codegraph = Get-Command codegraph -ErrorAction SilentlyContinue

if ($null -eq $codegraph) {
@"
# CodeGraph Context

CodeGraph is not available on PATH. Continue with normal repository inspection.
"@ | Set-Content -LiteralPath $Output -Encoding UTF8
    Write-Output $Output
    exit 0
}

function Invoke-CodeGraphText([string]$Candidate) {
    Push-Location $resolvedWorkingDirectory
    try {
        try {
            $commandOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $Candidate 2>&1
            if ($LASTEXITCODE -eq 0) { return (($commandOutput | ForEach-Object { [string]$_ }) -join "`n").Trim() }
        } catch {
            return ""
        }
        return ""
    } finally { Pop-Location }
}

$sections = @()
if (![string]::IsNullOrWhiteSpace($Command)) {
    $custom = Invoke-CodeGraphText $Command
    if (![string]::IsNullOrWhiteSpace($custom)) { $sections += "## Custom CodeGraph Command`n`n``````text`n$custom`n``````" }
} else {
    $files = Invoke-CodeGraphText "codegraph files --path . --format tree --max-depth 4"
    if (![string]::IsNullOrWhiteSpace($files)) { $sections += "## Indexed file structure`n`n``````text`n$files`n``````" }

    $context = Invoke-CodeGraphText "codegraph context 'Summarize this repository for an AI coding agent. Focus on main modules, scripts, tests, and likely entry points.' --path . --format markdown --no-code"
    if (![string]::IsNullOrWhiteSpace($context)) { $sections += "## Task context`n`n$context" }

    $status = Invoke-CodeGraphText "codegraph status ."
    if (![string]::IsNullOrWhiteSpace($status)) { $sections += "## Index status`n`n``````text`n$status`n``````" }
}

if ($sections.Count -eq 0) {
    $sections += "CodeGraph was found at $($codegraph.Source), but no context command succeeded. Continue with normal repository inspection."
}

$body = $sections -join "`n`n"
@"
# CodeGraph Context

Generated: $(Get-Date -Format o)
Working directory: $resolvedWorkingDirectory

$body
"@ | Set-Content -LiteralPath $Output -Encoding UTF8

Write-Output $Output
