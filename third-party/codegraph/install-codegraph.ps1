param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if ((Get-Command codegraph -ErrorAction SilentlyContinue) -and !$Force) {
    Write-Host "CodeGraph already available on PATH: $((Get-Command codegraph).Source)"
    exit 0
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $npm) {
    throw "CodeGraph is not installed and npm was not found. Install CodeGraph using its upstream instructions, then ensure 'codegraph' is on PATH."
}

Write-Host "Installing CodeGraph CLI with npm..."
& npm install -g codegraph
if ($LASTEXITCODE -ne 0) { throw "npm install -g codegraph failed" }

if (!(Get-Command codegraph -ErrorAction SilentlyContinue)) {
    throw "CodeGraph install finished but 'codegraph' is still not on PATH. Open a new terminal or check npm global bin path."
}
Write-Host "CodeGraph installed: $((Get-Command codegraph).Source)"
