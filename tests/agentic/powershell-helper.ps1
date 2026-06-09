$ErrorActionPreference = "Stop"

function Get-AgenticSmokePowerShell {
    [CmdletBinding()]
    param()

    $currentHost = (Get-Process -Id $PID).Path
    if ($currentHost -and (Test-Path -LiteralPath $currentHost -PathType Leaf)) {
        return $currentHost
    }

    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh -and $pwsh.Source -and (Test-Path -LiteralPath $pwsh.Source -PathType Leaf)) {
        return $pwsh.Source
    }

    throw "Could not find a PowerShell executable for agentic smoke tests. Run from PowerShell or install pwsh."
}
