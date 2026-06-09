#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

function Show-Usage {
@"
Usage: scripts/agentic/agentic-loop.ps1 [options]

Runs an agentic coding loop over agentic.json using fresh agent calls, worktrees, checks, and verifier gates.

Options:
  --goal <text>              Goal used to create agentic.json when missing or empty
  --tool <name>              Tool adapter: claude | pi | custom (default: claude)
  --command <template>       Executor command template. Use {prompt} for prompt file.
  --verifier-command <tpl>   Verifier command template. Defaults to --command/tool adapter.
  --max-iterations <n>       Max task iterations (default: agentic.json maxIterations, or 10)
  --checks <command>         Validation command to run in the task worktree (repeatable)
  --state <path>             State JSON path (default: agentic.json)
  --policy <path>            Workflow policy path (default: .agent-policy/workflow-policy.json, fallback templates/agent-policy/workflow-policy.json)
  --worktree-root <path>     Worktree root (default from policy, or .worktrees)
  --runs-root <path>         Prompt/result root (default from policy, or .agent-runs)
  --no-commit                Do not commit passing task branch
  --no-merge                 Do not merge passing task branch into current branch; leave it for review/--accept
  --auto-accept-passed       With --no-merge, auto-accept a task after checks and verifier pass
  --allow-dirty              Allow starting with uncommitted changes in main worktree
  --cleanup-passed           Remove passed task worktree after merge/no-merge handling
  --plan-only                Run planner, validate planner-result.json, update state, then stop
  --status                   Print current state summary and exit; allowed even when the worktree is dirty
  --accept <task-id>         Merge/cherry-pick an already passed no-merge task, clean up, then exit
  --max-retries <n>          Max automatic retries per task (default from policy, or 1)
  --merge-mode <mode>        Merge mode for pass/accept: ff-only | no-ff | cherry-pick (default: ff-only)

No-merge review flow:
  Run with --no-merge to commit a passing task on agentic/<safe-task-id>, mark it passed,
  and keep the worktree/branch for human review. Add --auto-accept-passed to integrate
  passed no-merge tasks immediately after checks and verifier pass. After review, run --accept <task-id>
  to integrate that passed task and remove its worktree/branch. --accept defaults to
  --merge-mode ff-only; use --merge-mode cherry-pick or no-ff when that is intentional.
  -h, --help                 Show this help

Environment overrides:
  AGENTIC_TOOL, AGENTIC_COMMAND, AGENTIC_VERIFIER_COMMAND, AGENTIC_MAX_ITERATIONS, AGENTIC_CHECKS

agentic.json shape:
  { "goal": "...", "maxIterations": 10, "checks": [], "tasks": [{ "id": "task-001", "status": "pending", "workflow": "tdd" }] }
"@
}

function Require-Command([string]$Name) {
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Missing required command: $Name" }
}

function Invoke-CheckedNative([string]$FilePath, [string[]]$NativeArgs, [string]$WorkingDirectory = "") {
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { & $FilePath @NativeArgs } else { & $FilePath -C $WorkingDirectory @NativeArgs }
    if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with code $LASTEXITCODE" }
}

function Invoke-ShellCommand([string]$Command, [string]$WorkingDirectory = "") {
    $old = Get-Location
    try {
        if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) { Set-Location -LiteralPath $WorkingDirectory }
        if ($IsWindows -or $PSVersionTable.PSEdition -eq "Desktop") { & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $Command }
        else { & sh -lc $Command }
        if ($LASTEXITCODE -ne 0) { throw "Command failed with code $LASTEXITCODE`: $Command" }
    } finally { Set-Location $old }
}

function ConvertTo-SafeSlug([string]$Value) {
    $slug = ($Value -replace '[^A-Za-z0-9._-]+', '-')
    if ([string]::IsNullOrWhiteSpace($slug)) { return "task" }
    return $slug.Trim('-')
}

$tool = if ($env:AGENTIC_TOOL) { $env:AGENTIC_TOOL } else { "claude" }
$commandTemplate = if ($env:AGENTIC_COMMAND) { $env:AGENTIC_COMMAND } else { "" }
$verifierCommandTemplate = if ($env:AGENTIC_VERIFIER_COMMAND) { $env:AGENTIC_VERIFIER_COMMAND } else { "" }
$maxIterations = if ($env:AGENTIC_MAX_ITERATIONS) { $env:AGENTIC_MAX_ITERATIONS } else { "" }
$stateFile = "agentic.json"
$policyFile = ""
$goal = ""
$worktreeRoot = ""
$runsRoot = ""
$commit = $true
$merge = $true
$autoAcceptPassed = $false
$allowDirty = $false
$cleanupPassed = $false
$planOnly = $false
$statusOnly = $false
$acceptTaskId = ""
$maxRetries = ""
$mergeMode = "ff-only"
$checks = @()
if ($env:AGENTIC_CHECKS) { $checks += $env:AGENTIC_CHECKS }

$cliArgs = @($args)
function Read-OptionValue([object[]]$CliArgs, [int]$Index, [string]$OptionName) {
    $valueIndex = $Index + 1
    if ($valueIndex -ge $CliArgs.Count -or [string]::IsNullOrWhiteSpace([string]$CliArgs[$valueIndex]) -or ([string]$CliArgs[$valueIndex]).StartsWith("--")) {
        Write-Output "Missing value for $OptionName."
        Show-Usage
        exit 2
    }
    return [string]$CliArgs[$valueIndex]
}

for ($i = 0; $i -lt $cliArgs.Count; $i++) {
    switch ($cliArgs[$i]) {
        "--goal" { $goal = Read-OptionValue $cliArgs $i "--goal"; $i++; continue }
        "--tool" { $tool = Read-OptionValue $cliArgs $i "--tool"; $i++; continue }
        "--command" { $commandTemplate = Read-OptionValue $cliArgs $i "--command"; $i++; continue }
        "--verifier-command" { $verifierCommandTemplate = Read-OptionValue $cliArgs $i "--verifier-command"; $i++; continue }
        "--max-iterations" { $maxIterations = Read-OptionValue $cliArgs $i "--max-iterations"; $i++; continue }
        "--checks" { $checks += Read-OptionValue $cliArgs $i "--checks"; $i++; continue }
        "--state" { $stateFile = Read-OptionValue $cliArgs $i "--state"; $i++; continue }
        "--policy" { $policyFile = Read-OptionValue $cliArgs $i "--policy"; $i++; continue }
        "--worktree-root" { $worktreeRoot = Read-OptionValue $cliArgs $i "--worktree-root"; $i++; continue }
        "--runs-root" { $runsRoot = Read-OptionValue $cliArgs $i "--runs-root"; $i++; continue }
        "--no-commit" { $commit = $false; continue }
        "--no-merge" { $merge = $false; continue }
        "--auto-accept-passed" { $autoAcceptPassed = $true; continue }
        "--allow-dirty" { $allowDirty = $true; continue }
        "--cleanup-passed" { $cleanupPassed = $true; continue }
        "--plan-only" { $planOnly = $true; continue }
        "--status" { $statusOnly = $true; continue }
        "--accept" { $acceptTaskId = Read-OptionValue $cliArgs $i "--accept"; $i++; continue }
        "--max-retries" { $maxRetries = Read-OptionValue $cliArgs $i "--max-retries"; $i++; continue }
        "--merge-mode" { $mergeMode = Read-OptionValue $cliArgs $i "--merge-mode"; $i++; continue }
        { $_ -in @("-h", "--help") } { Show-Usage; exit 0 }
        default { Write-Error "Unknown option: $($cliArgs[$i])"; Show-Usage; exit 2 }
    }
}

Require-Command git

function Resolve-PolicyFile {
    if (![string]::IsNullOrWhiteSpace($policyFile)) { return $policyFile }
    if (Test-Path -LiteralPath ".agent-policy/workflow-policy.json") { return ".agent-policy/workflow-policy.json" }
    if (Test-Path -LiteralPath "templates/agent-policy/workflow-policy.json") { return "templates/agent-policy/workflow-policy.json" }
    return ""
}

$resolvedPolicyFile = Resolve-PolicyFile
$policy = $null
if (![string]::IsNullOrWhiteSpace($resolvedPolicyFile) -and (Test-Path -LiteralPath $resolvedPolicyFile)) {
    $policy = Get-Content -LiteralPath $resolvedPolicyFile -Raw | ConvertFrom-Json
}
if ([string]::IsNullOrWhiteSpace($worktreeRoot)) { $worktreeRoot = if ($policy -and $policy.autonomousLoop.worktreeRoot) { [string]$policy.autonomousLoop.worktreeRoot } else { ".worktrees" } }
if ([string]::IsNullOrWhiteSpace($runsRoot)) { $runsRoot = if ($policy -and $policy.autonomousLoop.scratchRoot) { [string]$policy.autonomousLoop.scratchRoot } else { ".agent-runs" } }
if ([string]::IsNullOrWhiteSpace($maxRetries)) { $maxRetries = if ($policy -and $policy.autonomousLoop.maxRetriesPerTask) { [string]$policy.autonomousLoop.maxRetriesPerTask } else { "1" } }
[int]$maxRetriesValue = 0
if (!([int]::TryParse($maxRetries, [ref]$maxRetriesValue)) -or $maxRetriesValue -lt 0) { Write-Error "Invalid max retries: $maxRetries"; exit 2 }
if ($mergeMode -notin @("ff-only", "no-ff", "cherry-pick")) { Write-Error "Invalid merge mode: $mergeMode"; exit 2 }

function New-EmptyState([string]$GoalText) {
    [pscustomobject]@{
        version = 1
        goal = $GoalText
        phase = "planning"
        maxIterations = 10
        checks = @($checks)
        defaultDiscoveryWorkflow = "grill-with-docs"
        tasks = @()
        decisions = @()
        assumptions = @()
        openQuestions = @()
        blockers = @()
        promptPolicy = [pscustomobject]@{ lessons = @() }
    }
}

function Read-StateJson { return (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json) }
function Write-StateJson($State) { ConvertTo-Json -InputObject $State -Depth 30 | Set-Content -LiteralPath $stateFile -Encoding UTF8 }

$status = (& git status --porcelain)
if (!$statusOnly -and [string]::IsNullOrWhiteSpace($acceptTaskId) -and !$allowDirty -and $status) { Write-Error "Working tree is dirty. Commit/stash first, or pass --allow-dirty."; & git status --short | Write-Error; exit 1 }

if (!(Test-Path -LiteralPath $stateFile)) {
    if ([string]::IsNullOrWhiteSpace($goal)) { throw "Missing $stateFile. Pass --goal to create it, or create agentic.json first." }
    Write-StateJson (New-EmptyState $goal)
    Write-Host "Created $stateFile. Planner will populate tasks."
}

$state = Read-StateJson
if ($state.PSObject.Properties.Name -contains "checks" -and $state.checks) { $checks += @($state.checks) }
$checks = @($checks | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
if ([string]::IsNullOrWhiteSpace($maxIterations)) { if ($state.PSObject.Properties.Name -contains "maxIterations") { $maxIterations = [string]$state.maxIterations } }
if ([string]::IsNullOrWhiteSpace($maxIterations)) { $maxIterations = "10" }
[int]$maxIterationsValue = 0
if (!([int]::TryParse($maxIterations, [ref]$maxIterationsValue)) -or $maxIterationsValue -lt 1) { Write-Error "Invalid max iterations: $maxIterations"; exit 2 }

New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $worktreeRoot | Out-Null

function Get-Tasks($State) { if ($State.PSObject.Properties.Name -contains "tasks" -and $null -ne $State.tasks) { return @($State.tasks) }; return @() }
function Get-TaskStatusMap($State) {
    $map = @{}
    foreach ($task in (Get-Tasks $State)) {
        if ($task.id) { $map[[string]$task.id] = [string]$task.status }
    }
    return $map
}
function Test-DependenciesPassed($Task, $State) {
    $statusById = Get-TaskStatusMap $State
    foreach ($dep in @($Task.dependsOn)) {
        $depId = [string]$dep
        if (!$statusById.ContainsKey($depId) -or $statusById[$depId] -ne "passed") { return $false }
    }
    return $true
}
function Get-NextTask($State) {
    $eligible = @(Get-Tasks $State | Where-Object { $_.status -in @("pending", "needs_retry") -and (Test-DependenciesPassed $_ $State) } | Sort-Object @{ Expression = { if ($null -ne $_.priority) { [int]$_.priority } else { 999 } } }, @{ Expression = { if ($_.id) { [string]$_.id } else { "" } } })
    if ($eligible.Count -eq 0) { return $null }
    return $eligible[0]
}
function Test-HasUnfinishedTasks($State) {
    return @((Get-Tasks $State) | Where-Object { $_.status -notin @("passed", "blocked") }).Count -gt 0
}
function Get-BlockedDependencySummary($State) {
    $statusById = Get-TaskStatusMap $State
    $lines = @()
    foreach ($task in (Get-Tasks $State | Where-Object { $_.status -in @("pending", "needs_retry") })) {
        $waiting = @()
        foreach ($dep in @($task.dependsOn)) {
            $depId = [string]$dep
            $depStatus = if ($statusById.ContainsKey($depId)) { $statusById[$depId] } else { "missing" }
            if ($depStatus -ne "passed") { $waiting += "$depId=$depStatus" }
        }
        if ($waiting.Count -gt 0) { $lines += "$($task.id) waiting on $($waiting -join ', ')" }
    }
    return ($lines -join "`n")
}
function Set-TaskStatus([string]$Id, [string]$Status, [object]$Failure = $null) {
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s)) {
        if ([string]$task.id -eq $Id) {
            $task.status = $Status
            if ($Failure) {
                if (!($task.PSObject.Properties.Name -contains "failureHistory") -or $null -eq $task.failureHistory) { $task | Add-Member -NotePropertyName failureHistory -NotePropertyValue @() -Force }
                $task.failureHistory += $Failure
            }
        }
    }
    Write-StateJson $s
}
function Set-TaskPassed([string]$Id, $VerifierResult) {
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s)) {
        if ([string]$task.id -eq $Id) {
            $task.status = "passed"
            if (!($task.PSObject.Properties.Name -contains "completedAt")) { $task | Add-Member -NotePropertyName completedAt -NotePropertyValue "" -Force }
            $task.completedAt = Get-Date -Format o
            if ($VerifierResult -and ($VerifierResult.PSObject.Properties.Name -contains "artifacts") -and $VerifierResult.artifacts) {
                if (!($task.PSObject.Properties.Name -contains "artifacts") -or $null -eq $task.artifacts) { $task | Add-Member -NotePropertyName artifacts -NotePropertyValue @() -Force }
                $task.artifacts = @($task.artifacts) + @($VerifierResult.artifacts)
            }
        }
    }
    Write-StateJson $s
}
function Add-TaskAttempt([string]$Id, [string]$RunDir) {
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s)) {
        if ([string]$task.id -eq $Id) {
            $current = if ($task.PSObject.Properties.Name -contains "attempts" -and $null -ne $task.attempts) { [int]$task.attempts } else { 0 }
            if (!($task.PSObject.Properties.Name -contains "attempts")) { $task | Add-Member -NotePropertyName attempts -NotePropertyValue 0 -Force }
            if (!($task.PSObject.Properties.Name -contains "lastRunDir")) { $task | Add-Member -NotePropertyName lastRunDir -NotePropertyValue "" -Force }
            if (!($task.PSObject.Properties.Name -contains "startedAt")) { $task | Add-Member -NotePropertyName startedAt -NotePropertyValue "" -Force }
            $task.attempts = $current + 1
            $task.lastRunDir = $RunDir
            $task.startedAt = Get-Date -Format o
        }
    }
    Write-StateJson $s
}
function Get-TaskAttempts($Task) {
    if ($Task.PSObject.Properties.Name -contains "attempts" -and $null -ne $Task.attempts) { return [int]$Task.attempts }
    return 0
}
function Get-FailureStatusForTask($Task, [string]$Phase) {
    if ((Get-TaskAttempts $Task) -ge $maxRetriesValue) { return "needs_human" }
    if ($Phase -in @("executor", "harness")) { return "needs_human" }
    return "needs_retry"
}
function Show-AgenticStatus {
    if (!(Test-Path -LiteralPath $stateFile)) { Write-Output "No state file found: $stateFile"; return }
    $s = Read-StateJson
    Write-Output "Goal: $($s.goal)"
    Write-Output "Phase: $($s.phase)"
    Write-Output "State: $stateFile"
    Write-Output "Worktree root: $worktreeRoot"
    Write-Output "Runs root: $runsRoot"
    Write-Output "Tasks:"
    foreach ($task in (Get-Tasks $s | Sort-Object @{ Expression = { if ($null -ne $_.priority) { [int]$_.priority } else { 999 } } }, id)) {
        $deps = if ($task.dependsOn) { " deps=[" + (@($task.dependsOn) -join ",") + "]" } else { "" }
        Write-Output ("  {0,-12} {1,-12} {2,-16} {3}{4}" -f [string]$task.status, [string]$task.id, [string]$task.workflow, [string]$task.title, $deps)
    }
    $next = Get-NextTask $s
    if ($next) { Write-Output "Next runnable: $($next.id) - $($next.title)" }
    elseif (Test-HasUnfinishedTasks $s) { Write-Output "No runnable task. Blocked dependencies:`n$(Get-BlockedDependencySummary $s)" }
    else { Write-Output "All tasks complete." }
}
function Invoke-AcceptGit([string[]]$NativeArgs, [string]$Operation) {
    $output = & git @NativeArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $details = ($output | ForEach-Object { [string]$_ }) -join "`n"
        throw "$Operation failed with code $LASTEXITCODE. $details"
    }
    return $output
}
function Stop-AcceptWithMessage([string]$Message) {
    throw $Message
}
function Invoke-AcceptTask([string]$TaskId, [bool]$SkipDirtyCheck = $false) {
    $s = Read-StateJson
    $task = Get-Tasks $s | Where-Object { [string]$_.id -eq $TaskId } | Select-Object -First 1
    if ($null -eq $task) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': task not found in $stateFile." }
    if ([string]$task.status -ne "passed") { Stop-AcceptWithMessage "Cannot accept task '$TaskId': task status is '$($task.status)', expected 'passed'." }
    $acceptStatus = (& git status --porcelain)
    if (!$SkipDirtyCheck -and !$allowDirty -and $acceptStatus) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': working tree is dirty. Commit/stash first, or pass --allow-dirty.`n$((& git status --short) -join "`n")" }

    $safeId = ConvertTo-SafeSlug $TaskId
    $branch = "agentic/$safeId"
    $worktreePath = Join-Path $worktreeRoot $safeId
    $branchExists = (& git branch --list $branch)
    if (!$branchExists) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': branch '$branch' was not found." }

    $branchHead = (& git rev-parse $branch)
    $mainHead = (& git rev-parse HEAD)
    if ($branchHead -ne $mainHead) {
        $operation = switch ($mergeMode) {
            "ff-only" { "git merge --ff-only $branch" }
            "no-ff" { "git merge --no-ff $branch" }
            "cherry-pick" { "git cherry-pick $branch" }
        }
        try {
            switch ($mergeMode) {
                "ff-only" { Invoke-AcceptGit @("merge", "--ff-only", $branch) $operation | Out-Host }
                "no-ff" { Invoke-AcceptGit @("merge", "--no-ff", $branch, "-m", "agentic: accept $TaskId") $operation | Out-Host }
                "cherry-pick" { Invoke-AcceptGit @("cherry-pick", $branch) $operation | Out-Host }
            }
        } catch {
            Stop-AcceptWithMessage "Accept failed while running '$operation'. Worktree '$worktreePath' and branch '$branch' were left intact for manual recovery. $($_.Exception.Message)"
        }
    }
    else { Write-Host "No tracked branch changes to accept for $TaskId." }

    try {
        if (Test-Path -LiteralPath $worktreePath) { Invoke-AcceptGit @("worktree", "remove", $worktreePath) "git worktree remove $worktreePath" | Out-Host }
        Invoke-AcceptGit @("branch", "-D", $branch) "git branch -D $branch" | Out-Host
    } catch {
        Stop-AcceptWithMessage "Accept integrated '$TaskId' but cleanup failed. Inspect worktree '$worktreePath' and branch '$branch'. $($_.Exception.Message)"
    }

    Write-Output "<promise>ACCEPTED $TaskId</promise>"
}

if ($statusOnly) { Show-AgenticStatus; exit 0 }
if (![string]::IsNullOrWhiteSpace($acceptTaskId)) {
    try { Invoke-AcceptTask $acceptTaskId; exit 0 }
    catch { Write-Output $_.Exception.Message; exit 1 }
}

function Invoke-Agent([string]$PromptFile, [string]$Template, [string]$WorkingDirectory = "") {
    if (![string]::IsNullOrWhiteSpace($Template)) { Invoke-ShellCommand ($Template.Replace("{prompt}", (Resolve-Path -LiteralPath $PromptFile).Path)) $WorkingDirectory; return }
    switch ($tool) {
        "claude" { Require-Command claude; $prompt = Get-Content -LiteralPath $PromptFile -Raw; Invoke-ShellCommand "claude -p @'`n$prompt`n'@" $WorkingDirectory }
        "pi" {
            Require-Command pi
            $piCommand = Get-Command pi
            $resolvedPrompt = (Resolve-Path -LiteralPath $PromptFile).Path
            $old = Get-Location
            try {
                if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) { Set-Location -LiteralPath $WorkingDirectory }
                & pi -p "@$resolvedPrompt"
                if ($piCommand.CommandType -in @("Application", "ExternalScript") -and $LASTEXITCODE -ne 0) { throw "pi exited with code $LASTEXITCODE" }
            } finally {
                Set-Location $old
            }
        }
        "custom" { Write-Error "--tool custom requires --command '... {prompt} ...'"; exit 2 }
        default { Write-Error "Unknown tool '$tool'. Use --command for custom CLIs."; exit 2 }
    }
}

function Invoke-AgentWithLog([string]$PromptFile, [string]$Template, [string]$WorkingDirectory, [string]$LogPath) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    try { Invoke-Agent $PromptFile $Template $WorkingDirectory *>&1 | Tee-Object -FilePath $LogPath }
    catch {
        Add-Content -LiteralPath $LogPath -Value "ERROR: $($_.Exception.Message)"
        throw
    }
}

function Get-TaskChecks($Task) {
    $taskChecks = @()
    $taskChecks += @($checks)
    if ($Task -and ($Task.PSObject.Properties.Name -contains "validation") -and $Task.validation) { $taskChecks += @($Task.validation) }
    return @($taskChecks | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
}

function Invoke-Checks([string]$WorkingDirectory, [object[]]$ChecksToRun) {
    $log = @()
    $effectiveChecks = @($ChecksToRun | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
    if ($effectiveChecks.Count -eq 0) { return "No checks configured; agent exit success is the only external validation." }
    foreach ($check in $effectiveChecks) {
        Write-Host "Running check in $WorkingDirectory`: $check"
        try { Invoke-ShellCommand ([string]$check) $WorkingDirectory; $log += "PASS: $check" }
        catch { $log += "FAIL: $check`n$($_.Exception.Message)"; throw ($log -join "`n") }
    }
    return ($log -join "`n")
}

function Write-ChecksLog([string]$LogPath, [string]$Content) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    Set-Content -LiteralPath $LogPath -Value $Content -Encoding UTF8
}

function Write-DiffArtifacts([string]$WorktreePath, [string]$RunDir) {
    # Surface new files in the pre-commit diff without staging content.
    & git -C $WorktreePath add -N . 2>$null
    $patch = (& git -C $WorktreePath diff HEAD) -join "`n"
    $stat = (& git -C $WorktreePath diff --stat HEAD) -join "`n"
    Set-Content -LiteralPath (Join-Path $RunDir "diff.patch") -Value $patch -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $RunDir "diff-stat.txt") -Value $stat -Encoding UTF8
}

function New-RepoContext([string]$ContextFile) {
    $branch = (& git branch --show-current)
    $head = (& git rev-parse --short HEAD)
    $statusText = ((& git status --short) -join "`n")
    if ([string]::IsNullOrWhiteSpace($statusText)) { $statusText = "clean" }
    $topFiles = ((Get-ChildItem -Force | Select-Object -First 80 | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { $_.Name } }) -join "`n")
    $project = if (Test-Path -LiteralPath "PROJECT.md") { (Get-Content -LiteralPath "PROJECT.md" -Raw) } else { "PROJECT.md not found." }
    $context = if (Test-Path -LiteralPath "CONTEXT.md") { (Get-Content -LiteralPath "CONTEXT.md" -Raw) } else { "CONTEXT.md not found." }
    $agents = if (Test-Path -LiteralPath "AGENTS.md") { "AGENTS.md present" } else { "AGENTS.md not found" }
    $claude = if (Test-Path -LiteralPath "CLAUDE.md") { "CLAUDE.md present" } else { "CLAUDE.md not found" }
    $content = @"
# Agentic planner repository context

Goal: $($state.goal)

Git:
- Branch: $branch
- HEAD: $head
- Status: $statusText

Agent cookbooks:
- $agents
- $claude

Configured checks:
$($checks -join "`n")

Top-level files:
$topFiles

PROJECT.md:
$project

CONTEXT.md:
$context
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ContextFile) | Out-Null
    Set-Content -LiteralPath $ContextFile -Value $content -Encoding UTF8
}

function New-PlannerPrompt([string]$PromptFile, [string]$PlannerResultFile, [string]$RepoContextFile) {
    $policyText = if ($resolvedPolicyFile) { Get-Content -LiteralPath $resolvedPolicyFile -Raw -ErrorAction SilentlyContinue } else { "" }
    $content = @"
You are the planner for an autonomous agentic coding loop.

Read and follow AGENTS.md / CLAUDE.md if present. Use grill-with-docs-style discovery by default before planning: restate the goal, inspect repo docs/code for answers, separate decisions/assumptions/open questions, and stop with needs_human only for unresolved product/domain decisions.

The harness provided a context packet at: $RepoContextFile
Inspect deeper in the repository when needed.

Do not edit $stateFile directly. Write planner JSON only to: $PlannerResultFile

Allowed verdicts: planned, needs_human, blocked.
Allowed task statuses in planner output: pending, needs_human, blocked.
Allowed task kinds: discovery, investigation, implementation, architecture, maintenance, handoff.
Each task must have: id, title, kind, workflow, status, priority, acceptanceCriteria, validation, dependsOn, failureHistory, artifacts.
Use one workflow per task. Use dependencies for workflow sequences. Use only canonical workflows from the policy.

Planner result schema:
{
  "verdict": "planned|needs_human|blocked",
  "summary": "...",
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "tasks": []
}

Goal: $($state.goal)
Policy:
$policyText
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PromptFile) | Out-Null
    Set-Content -LiteralPath $PromptFile -Value $content -Encoding UTF8
}

function Get-AllowedWorkflows {
    if ($policy -and $policy.workflows) { return @($policy.workflows.PSObject.Properties.Name) }
    return @("grill-with-docs", "diagnose", "tdd", "zoom-out", "improve-codebase-architecture", "update-project-md", "handoff")
}

function Test-PlannerResult($PlannerResult) {
    $errors = @()
    if ($null -eq $PlannerResult) { return @("planner result is empty") }
    if ([string]$PlannerResult.verdict -notin @("planned", "needs_human", "blocked")) { $errors += "verdict must be planned, needs_human, or blocked" }
    $allowedWorkflows = Get-AllowedWorkflows
    $allowedKinds = @("discovery", "investigation", "implementation", "architecture", "maintenance", "handoff")
    $allowedStatuses = @("pending", "needs_human", "blocked")
    $ids = @{}
    foreach ($task in @($PlannerResult.tasks)) {
        if ([string]::IsNullOrWhiteSpace([string]$task.id)) { $errors += "task missing id"; continue }
        $id = [string]$task.id
        if ($ids.ContainsKey($id)) { $errors += "duplicate task id: $id" } else { $ids[$id] = $true }
        if ([string]::IsNullOrWhiteSpace([string]$task.title)) { $errors += "$id missing title" }
        if ([string]$task.kind -notin $allowedKinds) { $errors += "$id has invalid kind: $($task.kind)" }
        if ([string]$task.workflow -notin $allowedWorkflows) { $errors += "$id has invalid workflow: $($task.workflow)" }
        if ([string]$task.status -notin $allowedStatuses) { $errors += "$id has invalid status: $($task.status)" }
        if ($null -eq $task.priority) { $errors += "$id missing priority" }
    }
    foreach ($task in @($PlannerResult.tasks)) {
        foreach ($dep in @($task.dependsOn)) {
            if (!$ids.ContainsKey([string]$dep)) { $errors += "$($task.id) depends on unknown task: $dep" }
            if ([string]$dep -eq [string]$task.id) { $errors += "$($task.id) depends on itself" }
        }
    }
    return $errors
}

function Merge-PlannerResult($PlannerResult) {
    $s = Read-StateJson
    if ($PlannerResult.decisions) { $s.decisions = @($s.decisions) + @($PlannerResult.decisions) }
    if ($PlannerResult.assumptions) { $s.assumptions = @($s.assumptions) + @($PlannerResult.assumptions) }
    if ($PlannerResult.openQuestions) { $s.openQuestions = @($s.openQuestions) + @($PlannerResult.openQuestions) }
    if ($PlannerResult.blockers) { $s.blockers = @($s.blockers) + @($PlannerResult.blockers) }
    if ($PlannerResult.verdict -eq "planned") { $s.tasks = @($s.tasks) + @($PlannerResult.tasks); $s.phase = "execution" }
    elseif ($PlannerResult.verdict -eq "needs_human") { $s.phase = "needs_human" }
    else { $s.phase = "blocked" }
    Write-StateJson $s
}

function Get-WorkflowBlock([string]$Workflow) {
    if ($policy -and $policy.workflows -and ($policy.workflows.PSObject.Properties.Name -contains $Workflow)) {
        $workflowPolicy = $policy.workflows.$Workflow
        if ($workflowPolicy.executorBlock) {
            $required = if ($workflowPolicy.executorBlock.requiredWorkflow) { [string]$workflowPolicy.executorBlock.requiredWorkflow } else { $Workflow }
            $lines = @("Required workflow: use $required.")
            if ($workflowPolicy.executorBlock.expectedLoop) {
                $lines += "Expected loop:"
                $index = 1
                foreach ($step in @($workflowPolicy.executorBlock.expectedLoop)) {
                    $lines += "$index. $step"
                    $index++
                }
            }
            return ($lines -join "`n")
        }
    }

    return "Required workflow: use $Workflow. Read and follow the canonical SKILL.md for this workflow."
}

function New-ExecutorPrompt($Task, [int]$Iteration, [string]$PromptFile, [string]$RunDir) {
    $taskJson = $Task | ConvertTo-Json -Depth 20
    $workflow = if ($Task.workflow) { [string]$Task.workflow } else { "tdd" }
    $kind = if ($Task.kind) { [string]$Task.kind } else { "implementation" }
    $content = @"
You are executing one task inside an agentic harness worktree.

Hard rules:
- Complete exactly one task: the task JSON below.
- Read AGENTS.md / CLAUDE.md and follow repository rules.
- Read and follow the canonical SKILL.md for the selected workflow.
- The harness owns task status, verification, commits, and merges.
- Do not mark the task passed yourself.
- Do not edit upstream-derived files unless explicit permission is present.
- Keep task artifacts under this run directory when useful: $RunDir
- For discovery/investigation tasks, useful artifact files may be the main output; code changes are not required unless the task asks for them.
- For implementation/architecture/maintenance tasks, prefer tracked repo changes plus validation unless the task is explicitly artifact-only.

Iteration: $Iteration
State file: $stateFile
Selected workflow: $workflow
Task kind: $kind
Run directory: $RunDir

$(Get-WorkflowBlock $workflow)

Task JSON:
$taskJson
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PromptFile) | Out-Null
    Set-Content -LiteralPath $PromptFile -Value $content -Encoding UTF8
}

function New-VerifierPrompt($Task, [string]$WorktreePath, [string]$CheckOutput, [string]$ResultFile, [string]$PromptFile) {
    $taskJson = $Task | ConvertTo-Json -Depth 20
    $diffStat = (& git -C $WorktreePath diff --stat HEAD)
    $diff = (& git -C $WorktreePath diff HEAD)
    $gates = if ($policy -and $policy.humanGates) { ($policy.humanGates | ConvertTo-Json -Depth 10) } else { "[]" }
    $content = @"
You are the verifier for one agentic task.

Review the task, acceptance criteria, workflow, git diff, checks, and human gates. Write JSON only to this path: $ResultFile

Allowed verdicts: pass, fail, needs_human.
Schema: { "verdict": "pass|fail|needs_human", "summary": "...", "issues": [], "humanGates": [], "recommendedStatus": "passed|failed|needs_retry|needs_human|blocked", "artifacts": [] }

Task-kind guidance:
- discovery/investigation tasks may pass with artifact evidence and no git diff.
- implementation/architecture/maintenance tasks normally need tracked changes or a clear no-diff explanation.
- handoff tasks should produce a handoff artifact and usually recommend needs_human or blocked unless the task explicitly only asks for a handoff note.

Task JSON:
$taskJson

Human gates:
$gates

Check output:
$CheckOutput

Git diff stat:
$diffStat

Git diff:
$diff
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PromptFile) | Out-Null
    Set-Content -LiteralPath $PromptFile -Value $content -Encoding UTF8
}

# Plan if needed.
$state = Read-StateJson
if ((Get-Tasks $state).Count -eq 0) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $plannerRunDir = Join-Path $runsRoot "agentic-$timestamp-planner"
    $promptFile = Join-Path $plannerRunDir "planner.md"
    $repoContextFile = Join-Path $plannerRunDir "repo-context.md"
    $plannerResultFile = Join-Path $plannerRunDir "planner-result.json"
    $plannerResultForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $plannerResultFile
    $repoContextForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $repoContextFile

    New-RepoContext $repoContextFile
    New-PlannerPrompt $promptFile $plannerResultForPrompt $repoContextForPrompt
    Write-Host "=== Agentic planner ==="
    Invoke-Agent $promptFile $commandTemplate ""
    if (!(Test-Path -LiteralPath $plannerResultFile)) { throw "Planner did not write $plannerResultFile" }
    $plannerResult = Get-Content -LiteralPath $plannerResultFile -Raw | ConvertFrom-Json
    $plannerErrors = @(Test-PlannerResult $plannerResult)
    if ($plannerErrors.Count -gt 0) {
        $repairPrompt = Join-Path $plannerRunDir "planner-repair.md"
        $errorText = ($plannerErrors -join "`n")
        $original = Get-Content -LiteralPath $plannerResultFile -Raw
        Set-Content -LiteralPath $repairPrompt -Value @"
Your previous planner-result.json was invalid.

Validation errors:
$errorText

Original planner result:
$original

Rewrite valid planner JSON only to: $plannerResultForPrompt
Follow the schema and policy from the original planner prompt at: $promptFile
"@ -Encoding UTF8
        Write-Host "=== Agentic planner repair ==="
        Invoke-Agent $repairPrompt $commandTemplate ""
        if (!(Test-Path -LiteralPath $plannerResultFile)) { throw "Planner repair did not write $plannerResultFile" }
        $plannerResult = Get-Content -LiteralPath $plannerResultFile -Raw | ConvertFrom-Json
        $plannerErrors = @(Test-PlannerResult $plannerResult)
        if ($plannerErrors.Count -gt 0) { throw "Planner result invalid after repair:`n$($plannerErrors -join "`n")" }
    }
    Merge-PlannerResult $plannerResult
    if ($planOnly) {
        Write-Output "<promise>PLANNED</promise>"
        exit 0
    }
}

if ($planOnly) {
    Write-Output "<promise>PLANNED</promise>"
    exit 0
}

for ($iteration = 1; $iteration -le $maxIterationsValue; $iteration++) {
    $state = Read-StateJson
    $task = Get-NextTask $state
    if ($null -eq $task) {
        if (Test-HasUnfinishedTasks $state) {
            $blockedSummary = Get-BlockedDependencySummary $state
            Write-Error "No runnable task is available. Pending tasks are blocked by dependencies:`n$blockedSummary"
            exit 1
        }
        Write-Output "<promise>COMPLETE</promise>"
        exit 0
    }

    $taskId = if ($task.id) { [string]$task.id } else { "task-$iteration" }
    $safeId = ConvertTo-SafeSlug $taskId
    $branch = "agentic/$safeId"
    $worktreePath = Join-Path $worktreeRoot $safeId
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $runDir = Join-Path $runsRoot "agentic-$timestamp-$safeId"
    $runDirAbs = Join-Path (Resolve-Path -LiteralPath ".").Path $runDir
    $executorPrompt = Join-Path $runDirAbs "executor.md"
    $verifierPrompt = Join-Path $runDirAbs "verifier.md"
    $verifierResult = Join-Path $runDirAbs "verifier-result.json"
    $executorLog = Join-Path $runDirAbs "executor.log"
    $checksLog = Join-Path $runDirAbs "checks.log"
    $verifierLog = Join-Path $runDirAbs "verifier.log"
    $stateBefore = Join-Path $runDirAbs "state-before.json"
    $stateAfter = Join-Path $runDirAbs "state-after.json"
    $verifierResultForPrompt = $verifierResult

    Write-Host "=== Agentic iteration $iteration/$maxIterationsValue`: $taskId ==="
    New-Item -ItemType Directory -Force -Path $runDirAbs | Out-Null
    Copy-Item -LiteralPath $stateFile -Destination $stateBefore -Force
    Add-TaskAttempt $taskId $runDir
    $task = Get-Tasks (Read-StateJson) | Where-Object { [string]$_.id -eq $taskId } | Select-Object -First 1
    Set-TaskStatus $taskId "running"

    if (!(Test-Path -LiteralPath $worktreePath)) {
        Invoke-CheckedNative git @("worktree", "add", "-b", $branch, $worktreePath, "HEAD")
    }

    New-ExecutorPrompt $task $iteration $executorPrompt $runDir
    try {
        try { Invoke-AgentWithLog $executorPrompt $commandTemplate $worktreePath $executorLog }
        catch {
            Set-TaskStatus $taskId "needs_human" ([pscustomobject]@{ at = (Get-Date -Format o); phase = "executor"; reason = $_.Exception.Message; resultFile = $verifierResult })
            Write-ChecksLog $checksLog "Checks not run because executor failed."
            Write-DiffArtifacts $worktreePath $runDirAbs
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Executor failed for $taskId. Worktree retained at $worktreePath. $($_.Exception.Message)"
            exit 1
        }

        $taskChecks = Get-TaskChecks $task
        try { $checkOutput = Invoke-Checks $worktreePath $taskChecks; Write-ChecksLog $checksLog $checkOutput }
        catch {
            $checkOutput = $_.Exception.Message
            Write-ChecksLog $checksLog $checkOutput
            $failureStatus = Get-FailureStatusForTask $task "checks"
            Set-TaskStatus $taskId $failureStatus ([pscustomobject]@{ at = (Get-Date -Format o); phase = "checks"; reason = $_.Exception.Message; resultFile = $verifierResult })
            Write-DiffArtifacts $worktreePath $runDirAbs
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Checks failed for $taskId; marked $failureStatus. Worktree retained at $worktreePath. $($_.Exception.Message)"
            exit 1
        }

        Write-DiffArtifacts $worktreePath $runDirAbs
        New-VerifierPrompt $task $worktreePath $checkOutput $verifierResultForPrompt $verifierPrompt
        $verifierTemplate = if (![string]::IsNullOrWhiteSpace($verifierCommandTemplate)) { $verifierCommandTemplate } else { $commandTemplate }
        Invoke-AgentWithLog $verifierPrompt $verifierTemplate $worktreePath $verifierLog
        if (!(Test-Path -LiteralPath $verifierResult)) { throw "Verifier did not write $verifierResult" }
        $result = Get-Content -LiteralPath $verifierResult -Raw | ConvertFrom-Json
        $verdict = [string]$result.verdict
        if ($verdict -eq "pass") {
            if ($commit) {
                Invoke-CheckedNative git @("add", "-A") $worktreePath
                $changed = (& git -C $worktreePath status --porcelain)
                if ($changed) { Invoke-CheckedNative git @("commit", "-m", "agentic: complete $taskId") $worktreePath }
                else { Write-Host "No changes to commit for $taskId." }
            }
            if ($merge) {
                $branchHead = (& git rev-parse $branch)
                $mainHead = (& git rev-parse HEAD)
                if ($branchHead -ne $mainHead) {
                    switch ($mergeMode) {
                        "ff-only" { Invoke-CheckedNative git @("merge", "--ff-only", $branch) }
                        "no-ff" { Invoke-CheckedNative git @("merge", "--no-ff", $branch, "-m", "agentic: merge $taskId") }
                        "cherry-pick" { Invoke-CheckedNative git @("cherry-pick", $branch) }
                    }
                }
                else { Write-Host "No tracked branch changes to merge for $taskId." }
            }
            Set-TaskPassed $taskId $result
            if (!$merge -and $autoAcceptPassed) {
                try { Invoke-AcceptTask $taskId $true }
                catch {
                    Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
                    Write-Error "Auto-accept failed for $taskId. Worktree retained at $worktreePath and branch '$branch' remains for recovery. $($_.Exception.Message)"
                    exit 1
                }
            }
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Add-Content -Path (Join-Path $runsRoot "agentic-progress.txt") -Value "`n## $(Get-Date -Format o) $taskId`n- Verdict: pass`n- Summary: $($result.summary)"
            if ($cleanupPassed -and (Test-Path -LiteralPath $worktreePath)) { Invoke-CheckedNative git @("worktree", "remove", $worktreePath) }
        } elseif ($verdict -eq "needs_human") {
            Set-TaskStatus $taskId "needs_human" ([pscustomobject]@{ at = (Get-Date -Format o); phase = "verifier"; reason = $result.summary; resultFile = $verifierResult })
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Verifier returned needs_human for $taskId. Worktree retained at $worktreePath."
            exit 1
        } else {
            $failureStatus = Get-FailureStatusForTask $task "verifier"
            Set-TaskStatus $taskId $failureStatus ([pscustomobject]@{ at = (Get-Date -Format o); phase = "verifier"; reason = $result.summary; resultFile = $verifierResult })
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Verifier failed $taskId; marked $failureStatus. Worktree retained at $worktreePath."
            exit 1
        }
    } catch {
        Set-TaskStatus $taskId "needs_human" ([pscustomobject]@{ at = (Get-Date -Format o); phase = "harness"; reason = $_.Exception.Message; resultFile = $verifierResult })
        if (!(Test-Path -LiteralPath $checksLog)) { Write-ChecksLog $checksLog "Checks did not complete before harness failure." }
        if (!(Test-Path -LiteralPath (Join-Path $runDirAbs "diff.patch"))) { Write-DiffArtifacts $worktreePath $runDirAbs }
        Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
        Write-Error "Task $taskId failed in harness; marked needs_human. Worktree retained at $worktreePath. $($_.Exception.Message)"
        exit 1
    }
}

$state = Read-StateJson
if ($null -eq (Get-NextTask $state)) {
    if (Test-HasUnfinishedTasks $state) {
        $blockedSummary = Get-BlockedDependencySummary $state
        Write-Error "Reached max iterations or no runnable task is available. Pending tasks are blocked by dependencies:`n$blockedSummary"
        exit 1
    }
    Write-Output "<promise>COMPLETE</promise>"
    exit 0
}

Write-Error "Reached max iterations ($maxIterationsValue) with unfinished tasks."
exit 1
