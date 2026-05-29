#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

function Show-Usage {
    @"
Usage: scripts/ralph/ralph.ps1 [options]

Runs a Ralph-style fresh-agent loop over prd.json.

Options:
  --tool <name>              Tool adapter: claude | pi | custom (default: claude)
  --command <template>       Command template for custom/unknown CLIs. Use {prompt} for prompt file.
                             Example: --command 'my-agent run --prompt-file {prompt}'
  --max-iterations <n>       Max agent iterations (default: prd.json maxIterations, or 10)
  --checks <command>         Validation command to run after each iteration (repeatable)
  --no-commit                Do not commit successful iterations
  --allow-dirty              Allow starting with uncommitted changes
  --state <path>             PRD JSON path (default: prd.json)
  --progress <path>          Progress log path (default: progress.txt)
  -h, --help                 Show this help

Environment overrides:
  RALPH_TOOL, RALPH_COMMAND, RALPH_MAX_ITERATIONS, RALPH_CHECKS

prd.json must contain either:
  { "userStories": [{ "id": "...", "title": "...", "passes": false }] }
 or an array at the top level.
"@
}

function Require-Command([string]$Name) {
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Invoke-CheckedNative([string]$FilePath, [string[]]$NativeArgs) {
    & $FilePath @NativeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Invoke-ShellCommand([string]$Command) {
    if ($IsWindows -or $PSVersionTable.PSEdition -eq "Desktop") {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $Command
    } else {
        & sh -lc $Command
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with code $LASTEXITCODE`: $Command"
    }
}

$tool = if ($env:RALPH_TOOL) { $env:RALPH_TOOL } else { "claude" }
$commandTemplate = if ($env:RALPH_COMMAND) { $env:RALPH_COMMAND } else { "" }
$maxIterations = if ($env:RALPH_MAX_ITERATIONS) { $env:RALPH_MAX_ITERATIONS } else { "" }
$stateFile = "prd.json"
$progressFile = "progress.txt"
$commit = $true
$allowDirty = $false
$checks = @()
if ($env:RALPH_CHECKS) { $checks += $env:RALPH_CHECKS }

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--tool" { $i++; $tool = $args[$i]; continue }
        "--command" { $i++; $commandTemplate = $args[$i]; continue }
        "--max-iterations" { $i++; $maxIterations = $args[$i]; continue }
        "--checks" { $i++; $checks += $args[$i]; continue }
        "--no-commit" { $commit = $false; continue }
        "--allow-dirty" { $allowDirty = $true; continue }
        "--state" { $i++; $stateFile = $args[$i]; continue }
        "--progress" { $i++; $progressFile = $args[$i]; continue }
        { $_ -in @("-h", "--help") } { Show-Usage; exit 0 }
        default { Write-Error "Unknown option: $($args[$i])"; Show-Usage; exit 2 }
    }
}

Require-Command git

if (!(Test-Path -LiteralPath $stateFile)) {
    throw "Missing $stateFile. Create it from a PRD before running Ralph."
}

function Read-StateJson {
    return (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json)
}

function Write-StateJson($State) {
    ConvertTo-Json -InputObject $State -Depth 20 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

if ([string]::IsNullOrWhiteSpace($maxIterations)) {
    $state = Read-StateJson
    if ($state -isnot [array] -and $state.PSObject.Properties.Name -contains "maxIterations") {
        $maxIterations = [string]$state.maxIterations
    }
}
if ([string]::IsNullOrWhiteSpace($maxIterations)) { $maxIterations = "10" }
[int]$maxIterationsValue = 0
if (!([int]::TryParse($maxIterations, [ref]$maxIterationsValue)) -or $maxIterationsValue -lt 1) {
    Write-Error "Invalid max iterations: $maxIterations"
    exit 2
}

$status = (& git status --porcelain)
if (!$allowDirty -and $status) {
    Write-Error "Working tree is dirty. Commit/stash first, or pass --allow-dirty."
    & git status --short | Write-Error
    exit 1
}

if (!(Test-Path -LiteralPath $progressFile)) {
    New-Item -ItemType File -Path $progressFile | Out-Null
}

function Get-Stories($State) {
    if ($State -is [array]) { return @($State) }
    if ($State.PSObject.Properties.Name -contains "userStories" -and $null -ne $State.userStories) { return @($State.userStories) }
    return @()
}

function Get-StoryCount {
    return (Get-Stories (Read-StateJson)).Count
}

function Get-NextStoryJson {
    $stories = Get-Stories (Read-StateJson)
    $unfinished = @($stories | Where-Object { $_.passes -ne $true } | Sort-Object @{ Expression = { if ($null -ne $_.priority) { [int]$_.priority } else { 999 } } }, @{ Expression = { if ($_.id) { [string]$_.id } else { "" } } })
    if ($unfinished.Count -eq 0) { return "" }
    return ($unfinished[0] | ConvertTo-Json -Depth 20 -Compress)
}

function Test-AllDone {
    return [string]::IsNullOrWhiteSpace((Get-NextStoryJson))
}

function Set-StoryPassed([string]$Id) {
    $state = Read-StateJson
    $stories = Get-Stories $state
    foreach ($story in $stories) {
        if ([string]$story.id -eq $Id) { $story.passes = $true }
    }
    Write-StateJson $state
}

function New-RalphPrompt([string]$StoryJson, [int]$Iteration, [string]$PromptFile) {
    $recentProgress = ""
    if (Test-Path -LiteralPath $progressFile) {
        $recentProgress = ((Get-Content -LiteralPath $progressFile -Tail 80 -ErrorAction SilentlyContinue) -join "`n")
    }
    $content = @"
You are running one Ralph iteration in this repository.

Hard rules:
- Implement exactly one story: the story JSON below.
- Do not start another story.
- Read AGENTS.md / CLAUDE.md and follow repository rules.
- Do not modify upstream-derived mattpocock/skills files unless explicitly instructed by the user.
- Use PROJECT.md, CONTEXT.md, ADRs, and local docs as sources of truth.
- Keep temporary notes under .agent-runs/ if needed.
- Make the smallest durable change.
- Run targeted validation when possible.
- Leave the working tree in a coherent state.
- Append concise durable iteration notes to $progressFile.
- Do not mark the story as passing yourself; the harness does that after external checks pass.

Iteration: $Iteration
State file: $stateFile
Progress file: $progressFile

Story JSON:
$StoryJson

Recent progress:
$recentProgress
"@
    $parent = Split-Path -Parent $PromptFile
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -LiteralPath $PromptFile -Value $content -Encoding UTF8
}

function Invoke-Agent([string]$PromptFile) {
    if (![string]::IsNullOrWhiteSpace($commandTemplate)) {
        Invoke-ShellCommand ($commandTemplate.Replace("{prompt}", $PromptFile))
        return
    }

    switch ($tool) {
        "claude" {
            Require-Command claude
            $prompt = Get-Content -LiteralPath $PromptFile -Raw
            & claude -p $prompt
            if ($LASTEXITCODE -ne 0) { throw "claude exited with code $LASTEXITCODE" }
        }
        "pi" {
            Require-Command pi
            Get-Content -LiteralPath $PromptFile -Raw | & pi -p
            if ($LASTEXITCODE -ne 0) { throw "pi exited with code $LASTEXITCODE" }
        }
        "custom" {
            Write-Error "--tool custom requires --command '... {prompt} ...'"
            exit 2
        }
        default {
            Write-Error "Unknown tool '$tool'. Use --command for custom CLIs."
            exit 2
        }
    }
}

function Invoke-Checks {
    if ($checks.Count -eq 0) {
        Write-Host "No --checks configured; treating agent exit success as validation."
        return
    }
    foreach ($check in $checks) {
        Write-Host "Running check: $check"
        Invoke-ShellCommand $check
    }
}

if ((Get-StoryCount) -eq 0) {
    Write-Error "$stateFile has no stories."
    exit 1
}

for ($iteration = 1; $iteration -le $maxIterationsValue; $iteration++) {
    if (Test-AllDone) {
        Write-Output "<promise>COMPLETE</promise>"
        exit 0
    }

    $story = Get-NextStoryJson
    $storyObject = $story | ConvertFrom-Json
    $storyId = if ($storyObject.id) { [string]$storyObject.id } elseif ($storyObject.title) { [string]$storyObject.title } else { "story" }
    $safeId = ($storyId -replace '[^A-Za-z0-9._-]+', '-')
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $promptFile = Join-Path ".agent-runs" (Join-Path "ralph-$timestamp-$safeId" "prompt.md")
    New-RalphPrompt -StoryJson $story -Iteration $iteration -PromptFile $promptFile

    Write-Host "=== Ralph iteration $iteration/$maxIterationsValue`: $storyId ==="
    Invoke-Agent $promptFile
    Invoke-Checks

    $afterStatus = (& git status --porcelain)
    if (!$afterStatus) {
        Write-Error "Agent made no changes for $storyId; stopping."
        exit 1
    }

    Set-StoryPassed $storyId
    Add-Content -Path $progressFile -Value "`n## $(Get-Date -Format o) iteration $iteration`: $storyId`n- External checks passed. Marked story passes=true."

    if ($commit) {
        Invoke-CheckedNative -FilePath git -NativeArgs @("add", "-A")
        Invoke-CheckedNative -FilePath git -NativeArgs @("commit", "-m", "ralph: complete $storyId")
    } else {
        Write-Host "--no-commit set; leaving changes uncommitted."
    }
}

if (Test-AllDone) {
    Write-Output "<promise>COMPLETE</promise>"
} else {
    Write-Error "Reached max iterations ($maxIterationsValue) with unfinished stories."
    exit 1
}
