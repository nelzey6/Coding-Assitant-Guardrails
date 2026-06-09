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
  --checks <command>         Validation command to run in the task worktree (repeatable);
                             combined with each task.validation command before verifier
  --state <path>             State JSON path (default: agentic.json)
  --policy <path>            Workflow policy path (default: .agent-policy/workflow-policy.json, fallback templates/agent-policy/workflow-policy.json)
  --worktree-root <path>     Worktree root (default from policy, or .worktrees)
  --runs-root <path>         Prompt/result root (default from policy, or .agent-runs)
  --no-commit                Do not commit passing task branch
  --no-merge                 Do not merge passing task branch into current branch; leave it for review/--accept
  --review-branch            Opt-in review mode: use agentic/review/<safe-task-id> and keep active branch unchanged until --accept
  --auto-accept-passed       With --no-merge or --review-branch, auto-accept a task after task validation checks and verifier pass
  --allow-dirty              Allow starting with uncommitted changes in main worktree
  --cleanup-passed           Remove passed task worktree after merge/no-merge handling
  --plan-only                Run planner, validate planner-result.json, update state, then stop
  --status                   Print current state summary and exit; allowed even when the worktree is dirty
  --last-failure             Print the latest failure/status context and exit; dirty-tree safe
  --why-stuck                Explain blocked/needs_human/retryable tasks and suggested next commands; dirty-tree safe
  --summary                  Print a compact human checkpoint summary and exit; dirty-tree safe
  --doctor                   Diagnose stale review metadata and missing branches/worktrees without mutating state
  --reset-task <task-id>     Remove a task worktree/branch and mark it needs_retry for a clean rerun
  --fast-verifier            Skip the verifier agent after checks pass; opt-in for low-risk tasks only
  --no-finalize-docs         Skip the default final PROJECT.md/CONTEXT.md refresh after all tasks pass
  --agent-timeout-seconds <n>   Timeout for executor/verifier/finalizer agent commands (custom/template commands only)
  --check-timeout-seconds <n>   Timeout for each validation/check command
  --accept <task-id>         Merge/cherry-pick an already passed no-merge task, clean up, then exit;
                             use --merge-mode apply for accept apply/no-commit mode
  --retry <task-id>          Run a specific retryable failed task (needs_retry/failed) instead of
                             normal next-task priority/dependency selection; validates retry budget
  --max-retries <n>          Max automatic retries per task after the first attempt (default from policy, or 1)
  --merge-mode <mode>        Merge mode for pass/accept: ff-only | no-ff | cherry-pick | apply (default: ff-only)

Review flows:
  Default behavior still merges passing task branches into the active branch after verifier pass.
  Run with --no-merge to commit a passing task on agentic/<safe-task-id>, mark it passed,
  and keep the worktree/branch for human review. Run with --review-branch to use
  agentic/review/<safe-task-id> and keep the active branch unchanged until --accept.
  Add --auto-accept-passed to integrate reviewed tasks immediately after checks and verifier pass.
  After review, run --accept <task-id> to integrate that passed task and remove its worktree/branch.
  Use --merge-mode apply for single-task accept review: changes are applied with no commit
  (git cherry-pick --no-commit), staged in the current worktree, and the task worktree/branch
  are left intact for conservative cleanup after inspection.
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

function Invoke-ShellCommandCapture([string]$Command, [string]$WorkingDirectory = "", [int]$TimeoutSeconds = 0) {
    if ($TimeoutSeconds -le 0) {
        $old = Get-Location
        try {
            if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) { Set-Location -LiteralPath $WorkingDirectory }
            $output = if ($IsWindows -or $PSVersionTable.PSEdition -eq "Desktop") { & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $Command 2>&1 } else { & sh -lc $Command 2>&1 }
            $code = $LASTEXITCODE
            $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
            if ($code -ne 0) { throw "Command failed with code $code`: $Command`n$text" }
            return $text
        } finally { Set-Location $old }
    }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    if ($IsWindows -or $PSVersionTable.PSEdition -eq "Desktop") {
        $psi.FileName = "powershell.exe"
        $escaped = $Command.Replace('"', '\"')
        $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"$escaped`""
    } else {
        $psi.FileName = "sh"
        $escaped = $Command.Replace('"', '\"')
        $psi.Arguments = "-lc `"$escaped`""
    }
    if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) { $psi.WorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($psi)
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
        throw "Command timed out after $TimeoutSeconds seconds: $Command"
    }
    $text = ($process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()).TrimEnd()
    if ($process.ExitCode -ne 0) { throw "Command failed with code $($process.ExitCode)`: $Command`n$text" }
    return $text
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
$reviewBranchMode = $false
$autoAcceptPassed = $false
$allowDirty = $false
$cleanupPassed = $false
$planOnly = $false
$statusOnly = $false
$lastFailureOnly = $false
$whyStuckOnly = $false
$summaryOnly = $false
$doctorOnly = $false
$fastVerifier = $false
$finalizeDocs = $true
$acceptTaskId = ""
$resetTaskId = ""
$retryTaskId = ""
$agentTimeoutSeconds = 0
$checkTimeoutSeconds = 0
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
        "--review-branch" { $merge = $false; $reviewBranchMode = $true; continue }
        "--auto-accept-passed" { $autoAcceptPassed = $true; continue }
        "--allow-dirty" { $allowDirty = $true; continue }
        "--cleanup-passed" { $cleanupPassed = $true; continue }
        "--plan-only" { $planOnly = $true; continue }
        "--status" { $statusOnly = $true; continue }
        "--last-failure" { $lastFailureOnly = $true; continue }
        "--why-stuck" { $whyStuckOnly = $true; continue }
        "--summary" { $summaryOnly = $true; continue }
        "--doctor" { $doctorOnly = $true; continue }
        "--reset-task" { $resetTaskId = Read-OptionValue $cliArgs $i "--reset-task"; $i++; continue }
        "--fast-verifier" { $fastVerifier = $true; continue }
        "--no-finalize-docs" { $finalizeDocs = $false; continue }
        "--agent-timeout-seconds" { $agentTimeoutSeconds = [int](Read-OptionValue $cliArgs $i "--agent-timeout-seconds"); $i++; continue }
        "--check-timeout-seconds" { $checkTimeoutSeconds = [int](Read-OptionValue $cliArgs $i "--check-timeout-seconds"); $i++; continue }
        "--accept" { $acceptTaskId = Read-OptionValue $cliArgs $i "--accept"; $i++; continue }
        "--retry" { $retryTaskId = Read-OptionValue $cliArgs $i "--retry"; $i++; continue }
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
if ($mergeMode -notin @("ff-only", "no-ff", "cherry-pick", "apply")) { Write-Error "Invalid merge mode: $mergeMode"; exit 2 }

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

function Ensure-NoteProperty($Object, [string]$Name, $Value) {
    if (!($Object.PSObject.Properties.Name -contains $Name) -or $null -eq $Object.$Name) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
    }
}

function Normalize-StateJson($State) {
    if ($null -eq $State) { return (New-EmptyState "") }

    Ensure-NoteProperty $State "version" 1
    Ensure-NoteProperty $State "goal" ""
    Ensure-NoteProperty $State "phase" "execution"
    Ensure-NoteProperty $State "maxIterations" 10
    Ensure-NoteProperty $State "checks" ([object[]]@())
    Ensure-NoteProperty $State "tasks" ([object[]]@())
    Ensure-NoteProperty $State "decisions" ([object[]]@())
    Ensure-NoteProperty $State "assumptions" ([object[]]@())
    Ensure-NoteProperty $State "openQuestions" ([object[]]@())
    Ensure-NoteProperty $State "blockers" ([object[]]@())
    Ensure-NoteProperty $State "promptPolicy" ([pscustomobject]@{ lessons = @() })

    foreach ($task in @($State.tasks)) {
        Ensure-NoteProperty $task "id" ""
        Ensure-NoteProperty $task "title" ""
        Ensure-NoteProperty $task "kind" "implementation"
        Ensure-NoteProperty $task "workflow" "tdd"
        Ensure-NoteProperty $task "status" "pending"
        Ensure-NoteProperty $task "priority" 999
        Ensure-NoteProperty $task "acceptanceCriteria" ([object[]]@())
        Ensure-NoteProperty $task "validation" ([object[]]@())
        Ensure-NoteProperty $task "dependsOn" ([object[]]@())
        Ensure-NoteProperty $task "failureHistory" ([object[]]@())
        Ensure-NoteProperty $task "artifacts" ([object[]]@())
    }

    return $State
}

function Read-StateJson { return (Normalize-StateJson (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json)) }
function Write-StateJson($State) { ConvertTo-Json -InputObject (Normalize-StateJson $State) -Depth 30 | Set-Content -LiteralPath $stateFile -Encoding UTF8 }

$status = (& git status --porcelain)
$readOnlyMode = $statusOnly -or $doctorOnly -or $lastFailureOnly -or $whyStuckOnly -or $summaryOnly
if (!$readOnlyMode -and [string]::IsNullOrWhiteSpace($acceptTaskId) -and [string]::IsNullOrWhiteSpace($resetTaskId) -and !$allowDirty -and $status) { Write-Error "Working tree is dirty. Commit/stash first, or pass --allow-dirty."; & git status --short | Write-Error; exit 1 }
if (![string]::IsNullOrWhiteSpace($acceptTaskId) -and ![string]::IsNullOrWhiteSpace($retryTaskId)) { Write-Error "Use either --accept or --retry, not both."; exit 2 }
if (![string]::IsNullOrWhiteSpace($acceptTaskId) -and ![string]::IsNullOrWhiteSpace($resetTaskId)) { Write-Error "Use either --accept or --reset-task, not both."; exit 2 }

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

if (!$doctorOnly -and [string]::IsNullOrWhiteSpace($acceptTaskId)) {
    New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $worktreeRoot | Out-Null
}
$eventLogPath = Join-Path $runsRoot "events.jsonl"

function Write-AgenticEvent([string]$Type, [hashtable]$Data = @{}) {
    $entry = [ordered]@{ ts = (Get-Date -Format o); type = $Type; state = $stateFile }
    foreach ($key in $Data.Keys) { $entry[$key] = $Data[$key] }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $eventLogPath) | Out-Null
    Add-Content -LiteralPath $eventLogPath -Value (ConvertTo-Json -InputObject $entry -Depth 20 -Compress) -Encoding UTF8
}

function Get-RecentAgenticHistory([int]$Limit = 12) {
    if (!(Test-Path -LiteralPath $eventLogPath)) { return "No prior event log entries." }
    $lines = @(Get-Content -LiteralPath $eventLogPath | Select-Object -Last $Limit)
    if ($lines.Count -eq 0) { return "No prior event log entries." }
    return ($lines -join "`n")
}

function ConvertTo-MetricObject([hashtable]$Metrics) {
    $obj = [ordered]@{}
    foreach ($key in ($Metrics.Keys | Sort-Object)) { $obj[$key] = $Metrics[$key] }
    return $obj
}

function Parse-MetricLines([string]$Text) {
    $metrics = @{}
    foreach ($match in [regex]::Matches($Text, '(?m)^METRIC\s+([\w.u]+)=([^\s]+)\s*$')) {
        $name = $match.Groups[1].Value
        if ($name -in @('__proto__', 'constructor', 'prototype')) { continue }
        [double]$value = 0
        if ([double]::TryParse($match.Groups[2].Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) { $metrics[$name] = $value }
    }
    return $metrics
}

function Format-MetricsForPrompt([hashtable]$Metrics) {
    if ($Metrics.Count -eq 0) { return "No structured METRIC lines were emitted." }
    return (($Metrics.Keys | Sort-Object | ForEach-Object { "METRIC $_=$($Metrics[$_])" }) -join "`n")
}

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
    if (![string]::IsNullOrWhiteSpace($retryTaskId)) { return Get-RetryTaskOrExit $State $retryTaskId }
    $eligible = @(Get-Tasks $State | Where-Object { $_.status -in @("pending", "needs_retry") -and (Test-DependenciesPassed $_ $State) } | Sort-Object @{ Expression = { if ($null -ne $_.priority) { [int]$_.priority } else { 999 } } }, @{ Expression = { if ($_.id) { [string]$_.id } else { "" } } })
    if ($eligible.Count -eq 0) { return $null }
    return $eligible[0]
}
function Test-HasUnfinishedTasks($State) {
    return @((Get-Tasks $State) | Where-Object { $_.status -notin @("passed", "blocked") }).Count -gt 0
}
function Get-TaskProgressSummary($State) {
    $tasks = @(Get-Tasks $State)
    $total = $tasks.Count
    $completed = @($tasks | Where-Object { $_.status -eq "passed" }).Count
    $unfinished = @($tasks | Where-Object { $_.status -notin @("passed", "blocked") }).Count
    return [pscustomobject]@{ Total = $total; Completed = $completed; Unfinished = $unfinished }
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
    $event = @{ task = $Id; status = $Status }
    if ($Failure) { $event["failure"] = $Failure }
    Write-AgenticEvent "task_status" $event
}
function Set-TaskPassed([string]$Id, $VerifierResult, [string]$ReviewBranch = "", [string]$ReviewWorktree = "") {
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s)) {
        if ([string]$task.id -eq $Id) {
            $task.status = "passed"
            if (!($task.PSObject.Properties.Name -contains "completedAt")) { $task | Add-Member -NotePropertyName completedAt -NotePropertyValue "" -Force }
            $task.completedAt = Get-Date -Format o
            if (![string]::IsNullOrWhiteSpace($ReviewBranch)) {
                if (!($task.PSObject.Properties.Name -contains "reviewBranch")) { $task | Add-Member -NotePropertyName reviewBranch -NotePropertyValue "" -Force }
                $task.reviewBranch = $ReviewBranch
            }
            if (![string]::IsNullOrWhiteSpace($ReviewWorktree)) {
                if (!($task.PSObject.Properties.Name -contains "reviewWorktree")) { $task | Add-Member -NotePropertyName reviewWorktree -NotePropertyValue "" -Force }
                $task.reviewWorktree = $ReviewWorktree
            }
            if ($VerifierResult -and ($VerifierResult.PSObject.Properties.Name -contains "artifacts") -and $VerifierResult.artifacts) {
                if (!($task.PSObject.Properties.Name -contains "artifacts") -or $null -eq $task.artifacts) { $task | Add-Member -NotePropertyName artifacts -NotePropertyValue @() -Force }
                $task.artifacts = @($task.artifacts) + @($VerifierResult.artifacts)
            }
        }
    }
    Write-StateJson $s
    $event = @{ task = $Id; status = "passed" }
    if (![string]::IsNullOrWhiteSpace($ReviewBranch)) { $event["reviewBranch"] = $ReviewBranch }
    if (![string]::IsNullOrWhiteSpace($ReviewWorktree)) { $event["reviewWorktree"] = $ReviewWorktree }
    if ($VerifierResult -and ($VerifierResult.PSObject.Properties.Name -contains "summary")) { $event["summary"] = [string]$VerifierResult.summary }
    Write-AgenticEvent "task_passed" $event
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
    Write-AgenticEvent "task_attempt" @{ task = $Id; runDir = $RunDir }
}
function Get-TaskAttempts($Task) {
    if ($Task.PSObject.Properties.Name -contains "attempts" -and $null -ne $Task.attempts) { return [int]$Task.attempts }
    return 0
}
function Test-RetryBudgetAvailable($Task) {
    return (Get-TaskAttempts $Task) -le $maxRetriesValue
}
function Test-RetryableTaskStatus([string]$Status) {
    return $Status -in @("needs_retry", "failed")
}
function Get-RetryTaskOrExit($State, [string]$TaskId) {
    $task = Get-Tasks $State | Where-Object { [string]$_.id -eq $TaskId } | Select-Object -First 1
    if ($null -eq $task) { Write-Error "Cannot retry task '$TaskId': task not found in $stateFile."; exit 1 }
    if (!(Test-RetryableTaskStatus ([string]$task.status))) { Write-Error "Cannot retry task '$TaskId': status is '$($task.status)', expected needs_retry or failed."; exit 1 }
    if (!(Test-DependenciesPassed $task $State)) { Write-Error "Cannot retry task '$TaskId': dependencies are not passed."; exit 1 }
    if (!(Test-RetryBudgetAvailable $task)) { Write-Error "Cannot retry task '$TaskId': retry budget exhausted (attempts=$($task.attempts), max-retries=$maxRetriesValue)."; exit 1 }
    return $task
}
function Get-FailureStatusForTask($Task, [string]$Phase) {
    if ($Phase -in @("executor", "harness")) { return "needs_human" }
    if (Test-RetryBudgetAvailable $Task) { return "needs_retry" }
    return "needs_human"
}
function Complete-RetryableFailure([string]$TaskId, [string]$FailureStatus, [string]$Message) {
    if ($FailureStatus -eq "needs_retry") { Write-Warning $Message; return }
    [Console]::Error.WriteLine($Message)
    exit 1
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
        $review = if ($task.PSObject.Properties.Name -contains "reviewBranch" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) { " review=[$($task.reviewBranch)]" } else { "" }
        Write-Output ("  {0,-12} {1,-12} {2,-16} {3}{4}{5}" -f [string]$task.status, [string]$task.id, [string]$task.workflow, [string]$task.title, $deps, $review)
    }
    $next = Get-NextTask $s
    if ($next) { Write-Output "Next runnable: $($next.id) - $($next.title)" }
    elseif (Test-HasUnfinishedTasks $s) { Write-Output "No runnable task. Blocked dependencies:`n$(Get-BlockedDependencySummary $s)" }
    else { Write-Output "All tasks complete." }
    Write-Output "Recent events:"
    Write-Output (Get-RecentAgenticHistory 8)
}
function Get-FailureEvents([int]$Limit = 20) {
    if (!(Test-Path -LiteralPath $eventLogPath)) { return @() }
    $events = @()
    foreach ($line in @(Get-Content -LiteralPath $eventLogPath | Select-Object -Last 200)) {
        try {
            $event = $line | ConvertFrom-Json
            if ([string]$event.type -match 'failed|failure|needs_human|task_status') { $events += $event }
        } catch {}
    }
    return @($events | Select-Object -Last $Limit)
}

function Show-LastFailure {
    $events = @(Get-FailureEvents 1)
    if ($events.Count -gt 0) {
        Write-Output "Latest failure/status event:"
        Write-Output ($events[0] | ConvertTo-Json -Depth 20)
        return
    }
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s | Where-Object { $_.failureHistory } | Select-Object -Last 1)) {
        Write-Output "Latest task failureHistory:"
        Write-Output ($task | ConvertTo-Json -Depth 20)
        return
    }
    Write-Output "No failure events or task failureHistory found."
}

function Show-WhyStuck {
    if (!(Test-Path -LiteralPath $stateFile)) { Write-Output "No state file found: $stateFile"; return }
    $s = Read-StateJson
    $tasks = @(Get-Tasks $s)
    Write-Output "Why-stuck analysis for: $($s.goal)"
    $needsHuman = @($tasks | Where-Object { [string]$_.status -eq "needs_human" })
    $retryable = @($tasks | Where-Object { [string]$_.status -in @("needs_retry", "failed") })
    $pendingBlocked = @($tasks | Where-Object { [string]$_.status -eq "pending" -and !(Test-DependenciesPassed $_ $s) })
    if ($needsHuman.Count -eq 0 -and $retryable.Count -eq 0 -and $pendingBlocked.Count -eq 0) {
        $next = Get-NextTask $s
        if ($next) { Write-Output "Not stuck: next runnable task is $($next.id). Suggested: run the loop normally." }
        else { Write-Output "No stuck tasks detected. All tasks may be complete." }
    }
    foreach ($task in $needsHuman) { Write-Output "needs_human: $($task.id) - inspect $($task.lastRunDir); resolve manually or split/reset if safe." }
    foreach ($task in $retryable) { Write-Output "retryable: $($task.id) attempts=$(Get-TaskAttempts $task)/$maxRetriesValue - suggested: --retry $($task.id) or --reset-task $($task.id)." }
    foreach ($task in $pendingBlocked) { Write-Output "blocked by dependencies: $($task.id) waits on [$(@($task.dependsOn) -join ', ')]." }
    Write-Output "Recent failures:"
    foreach ($event in @(Get-FailureEvents 5)) { Write-Output ($event | ConvertTo-Json -Depth 10 -Compress) }
}

function Show-CheckpointSummary {
    if (!(Test-Path -LiteralPath $stateFile)) { Write-Output "No state file found: $stateFile"; return }
    $s = Read-StateJson
    $tasks = @(Get-Tasks $s)
    Write-Output "# Agentic checkpoint summary"
    Write-Output "Goal: $($s.goal)"
    Write-Output "Phase: $($s.phase)"
    foreach ($statusName in @("passed", "pending", "needs_retry", "needs_human", "blocked", "running")) {
        $count = @($tasks | Where-Object { [string]$_.status -eq $statusName }).Count
        if ($count -gt 0) { Write-Output "- $statusName`: $count" }
    }
    $next = Get-NextTask $s
    if ($next) { Write-Output "Next: $($next.id) - $($next.title)" }
    Write-Output "Recent events:"
    Write-Output (Get-RecentAgenticHistory 12)
}

function Reset-AgenticTask([string]$TaskId) {
    $s = Read-StateJson
    $task = Get-Tasks $s | Where-Object { [string]$_.id -eq $TaskId } | Select-Object -First 1
    if ($null -eq $task) { throw "Cannot reset task '$TaskId': task not found." }
    $safeId = ConvertTo-SafeSlug $TaskId
    $branch = if ($task.PSObject.Properties.Name -contains "reviewBranch" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) { [string]$task.reviewBranch } else { "agentic/$safeId" }
    $worktreePath = if ($task.PSObject.Properties.Name -contains "reviewWorktree" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewWorktree)) { [string]$task.reviewWorktree } else { Join-Path $worktreeRoot $safeId }
    if (Test-Path -LiteralPath $worktreePath) { Invoke-CheckedNative git @("worktree", "remove", "--force", $worktreePath) }
    if (Test-GitBranchExists $branch) { Invoke-CheckedNative git @("branch", "-D", $branch) }
    foreach ($candidate in (Get-Tasks $s)) {
        if ([string]$candidate.id -eq $TaskId) {
            $candidate.status = "needs_retry"
            if ($candidate.PSObject.Properties.Name -contains "reviewBranch") { $candidate.reviewBranch = "" }
            if ($candidate.PSObject.Properties.Name -contains "reviewWorktree") { $candidate.reviewWorktree = "" }
        }
    }
    Write-StateJson $s
    Write-AgenticEvent "task_reset" @{ task = $TaskId; branch = $branch; worktree = $worktreePath; status = "needs_retry" }
    Write-Output "Reset $TaskId. Suggested next command: --retry $TaskId"
}

function Test-GitBranchExists([string]$Branch) {
    if ([string]::IsNullOrWhiteSpace($Branch)) { return $false }
    $output = & git branch --list $Branch
    return ($LASTEXITCODE -eq 0 -and $null -ne $output -and @($output).Count -gt 0)
}
function Invoke-AgenticDoctor {
    $script:AgenticDoctorExitCode = 0
    if (!(Test-Path -LiteralPath $stateFile)) { Write-Output "No state file found: $stateFile"; $script:AgenticDoctorExitCode = 1; return }
    $s = Read-StateJson
    $issues = @()
    foreach ($task in (Get-Tasks $s)) {
        $taskId = [string]$task.id
        if ($task.PSObject.Properties.Name -contains "reviewBranch" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) {
            $branch = [string]$task.reviewBranch
            if (!(Test-GitBranchExists $branch)) { $issues += "[$taskId] review branch missing: $branch" }
        }
        if ($task.PSObject.Properties.Name -contains "reviewWorktree" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewWorktree)) {
            $worktree = [string]$task.reviewWorktree
            if (!(Test-Path -LiteralPath $worktree -PathType Container)) { $issues += "[$taskId] review worktree missing: $worktree" }
        }
    }
    if ($issues.Count -eq 0) {
        Write-Output "Doctor found no issues."
        $script:AgenticDoctorExitCode = 0
        return
    }
    Write-Output "Doctor found $($issues.Count) issue(s):"
    foreach ($issue in $issues) { Write-Output "  - $issue" }
    $script:AgenticDoctorExitCode = 1
    return
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
function Clear-TaskReviewState([string]$TaskId) {
    $s = Read-StateJson
    foreach ($task in (Get-Tasks $s)) {
        if ([string]$task.id -eq $TaskId) {
            if ($task.PSObject.Properties.Name -contains "reviewBranch") { $task.reviewBranch = "" }
            if ($task.PSObject.Properties.Name -contains "reviewWorktree") { $task.reviewWorktree = "" }
            if (!($task.PSObject.Properties.Name -contains "acceptedAt")) { $task | Add-Member -NotePropertyName acceptedAt -NotePropertyValue "" -Force }
            $task.acceptedAt = Get-Date -Format o
        }
    }
    Write-StateJson $s
}
function Invoke-AcceptTask([string]$TaskId, [bool]$SkipDirtyCheck = $false) {
    $s = Read-StateJson
    $task = Get-Tasks $s | Where-Object { [string]$_.id -eq $TaskId } | Select-Object -First 1
    if ($null -eq $task) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': task not found in $stateFile." }
    if ([string]$task.status -ne "passed") { Stop-AcceptWithMessage "Cannot accept task '$TaskId': task status is '$($task.status)', expected 'passed'." }
    $acceptStatus = (& git status --porcelain)
    if (!$SkipDirtyCheck -and !$allowDirty -and $acceptStatus) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': working tree is dirty. Commit/stash first, or pass --allow-dirty.`n$((& git status --short) -join "`n")" }

    $safeId = ConvertTo-SafeSlug $TaskId
    $branch = if ($task.PSObject.Properties.Name -contains "reviewBranch" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewBranch)) { [string]$task.reviewBranch } else { "agentic/$safeId" }
    $worktreePath = if ($task.PSObject.Properties.Name -contains "reviewWorktree" -and ![string]::IsNullOrWhiteSpace([string]$task.reviewWorktree)) { [string]$task.reviewWorktree } else { Join-Path $worktreeRoot $safeId }
    $branchExists = (& git branch --list $branch)
    if (!$branchExists) { Stop-AcceptWithMessage "Cannot accept task '$TaskId': branch '$branch' was not found." }

    $branchHead = (& git rev-parse $branch)
    $mainHead = (& git rev-parse HEAD)
    if ($branchHead -ne $mainHead) {
        $operation = switch ($mergeMode) {
            "ff-only" { "git merge --ff-only $branch" }
            "no-ff" { "git merge --no-ff $branch" }
            "cherry-pick" { "git cherry-pick $branch" }
            "apply" { "git cherry-pick --no-commit $branch" }
        }
        try {
            switch ($mergeMode) {
                "ff-only" { Invoke-AcceptGit @("merge", "--ff-only", $branch) $operation | Out-Host }
                "no-ff" { Invoke-AcceptGit @("merge", "--no-ff", $branch, "-m", "agentic: accept $TaskId") $operation | Out-Host }
                "cherry-pick" { Invoke-AcceptGit @("cherry-pick", $branch) $operation | Out-Host }
                "apply" { Invoke-AcceptGit @("cherry-pick", "--no-commit", $branch) $operation | Out-Host }
            }
        } catch {
            $modeHint = if ($mergeMode -eq "apply") { " The apply/no-commit mode may leave conflict state in the current worktree; resolve it or run 'git cherry-pick --abort' before retrying." } else { "" }
            Stop-AcceptWithMessage "Accept failed while running '$operation'.$modeHint Worktree '$worktreePath' and branch '$branch' were left intact for manual recovery. $($_.Exception.Message)"
        }
    }
    else { Write-Host "No tracked branch changes to accept for $TaskId." }

    if ($mergeMode -eq "apply") {
        Write-AgenticEvent "task_accepted" @{ task = $TaskId; branch = $branch; mergeMode = $mergeMode; cleanup = $false }
        Write-Output "Applied '$TaskId' without committing. Inspect staged/unstaged changes in the current worktree. Task worktree '$worktreePath' and branch '$branch' were left intact; remove them after review if no longer needed."
        Write-Output "<promise>ACCEPTED $TaskId</promise>"
        return
    }

    try {
        if (Test-Path -LiteralPath $worktreePath) { Invoke-AcceptGit @("worktree", "remove", $worktreePath) "git worktree remove $worktreePath" | Out-Host }
        Invoke-AcceptGit @("branch", "-D", $branch) "git branch -D $branch" | Out-Host
        Clear-TaskReviewState $TaskId
    } catch {
        Stop-AcceptWithMessage "Accept integrated '$TaskId' but cleanup failed. Inspect worktree '$worktreePath' and branch '$branch'. $($_.Exception.Message)"
    }

    Write-AgenticEvent "task_accepted" @{ task = $TaskId; branch = $branch; mergeMode = $mergeMode; cleanup = $true }
    Write-Output "<promise>ACCEPTED $TaskId</promise>"
}

if ($statusOnly) { Show-AgenticStatus; exit 0 }
if ($lastFailureOnly) { Show-LastFailure; exit 0 }
if ($whyStuckOnly) { Show-WhyStuck; exit 0 }
if ($summaryOnly) { Show-CheckpointSummary; exit 0 }
if ($doctorOnly) { Invoke-AgenticDoctor; exit $script:AgenticDoctorExitCode }
if (![string]::IsNullOrWhiteSpace($resetTaskId)) {
    try { Reset-AgenticTask $resetTaskId; exit 0 }
    catch { Write-Output $_.Exception.Message; exit 1 }
}
if (![string]::IsNullOrWhiteSpace($acceptTaskId)) {
    try { Invoke-AcceptTask $acceptTaskId; exit 0 }
    catch { Write-Output $_.Exception.Message; exit 1 }
}

function Invoke-Agent([string]$PromptFile, [string]$Template, [string]$WorkingDirectory = "") {
    if (![string]::IsNullOrWhiteSpace($Template)) {
        $command = $Template.Replace("{prompt}", (Resolve-Path -LiteralPath $PromptFile).Path)
        if ($agentTimeoutSeconds -gt 0) { Write-Output (Invoke-ShellCommandCapture $command $WorkingDirectory $agentTimeoutSeconds) }
        else { Invoke-ShellCommand $command $WorkingDirectory }
        return
    }
    switch ($tool) {
        "claude" {
            Require-Command claude
            $prompt = Get-Content -LiteralPath $PromptFile -Raw
            $old = Get-Location
            try {
                if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) { Set-Location -LiteralPath $WorkingDirectory }
                & claude -p $prompt
                if ($LASTEXITCODE -ne 0) { throw "claude exited with code $LASTEXITCODE" }
            } finally { Set-Location $old }
        }
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
    $allMetrics = @{}
    $effectiveChecks = @($ChecksToRun | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
    if ($effectiveChecks.Count -eq 0) { return "No checks configured; agent exit success is the only external validation.`n`nStructured metrics:`nNo structured METRIC lines were emitted." }
    foreach ($check in $effectiveChecks) {
        Write-Host "Running check in $WorkingDirectory`: $check"
        try {
            $output = Invoke-ShellCommandCapture ([string]$check) $WorkingDirectory $checkTimeoutSeconds
            if (![string]::IsNullOrWhiteSpace($output)) { Write-Host $output }
            $metrics = Parse-MetricLines $output
            foreach ($key in $metrics.Keys) { $allMetrics[$key] = $metrics[$key] }
            $log += "PASS: $check"
            if (![string]::IsNullOrWhiteSpace($output)) { $log += $output }
        }
        catch {
            $failedMetrics = Parse-MetricLines $_.Exception.Message
            foreach ($key in $failedMetrics.Keys) { $allMetrics[$key] = $failedMetrics[$key] }
            $log += "FAIL: $check`n$($_.Exception.Message)"
            if ($allMetrics.Count -gt 0) { $log += "Structured metrics:`n$(Format-MetricsForPrompt $allMetrics)" }
            throw ($log -join "`n")
        }
    }
    $log += "Structured metrics:`n$(Format-MetricsForPrompt $allMetrics)"
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

function New-CodeGraphContext([string]$OutputFile, [string]$WorkingDirectory = ".") {
    $script = Join-Path (Resolve-Path -LiteralPath $PSScriptRoot).Path "..\context\codegraph-context.ps1"
    if (Test-Path -LiteralPath $script) {
        try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Output $OutputFile -WorkingDirectory $WorkingDirectory | Out-Null; return }
        catch {}
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputFile) | Out-Null
    Set-Content -LiteralPath $OutputFile -Value "# CodeGraph Context`n`nCodeGraph context helper was unavailable. Continue with normal repository inspection." -Encoding UTF8
}

function New-RepoContext([string]$ContextFile, [string]$CodeGraphFile = "") {
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

CodeGraph context:
$CodeGraphFile
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ContextFile) | Out-Null
    Set-Content -LiteralPath $ContextFile -Value $content -Encoding UTF8
}

function New-PlannerPrompt([string]$PromptFile, [string]$PlannerResultFile, [string]$RepoContextFile, [string]$GrillTranscriptFile, [string]$CodeGraphFile) {
    $policyText = if ($resolvedPolicyFile) { Get-Content -LiteralPath $resolvedPolicyFile -Raw -ErrorAction SilentlyContinue } else { "" }
    $content = @"
You are the planner for an autonomous agentic coding loop.

Read and follow AGENTS.md / CLAUDE.md if present. Use grill-with-docs-style discovery by default before planning: restate the goal, inspect repo docs/code for answers, separate decisions/assumptions/open questions, update CONTEXT.md when durable domain/product context changes, and stop with needs_human only for unresolved product/domain decisions.

The harness provided a context packet at: $RepoContextFile
The harness also generated optional CodeGraph context at: $CodeGraphFile
Use CodeGraph context for orientation before broad manual search, then verify conclusions against source files. If the artifact says CodeGraph is unavailable, continue normally.
Inspect deeper in the repository when needed.

When planning validation, propose focused task.validation commands that prove each task. If a task adds or changes a small smoke test/check that directly proves the change, include that newly added focused smoke command in the task.validation array so the harness runs it before verification. Prefer PowerShell Core examples in the form `pwsh -File path/to/smoke.ps1`; mention `powershell.exe` only for explicitly documented legacy Windows PowerShell compatibility.

Do not edit $stateFile directly. Write planner JSON only to: $PlannerResultFile
Also write an autonomous grill transcript markdown file to: $GrillTranscriptFile

The grill transcript must make your discovery visible for human review. Use this structure:
# Autonomous Grill Transcript
## Goal Restatement
## Questions, Evidence, Answers, Proposals
For each grill question include: question, repo/docs evidence inspected, autonomous answer, proposal/decision, and whether human input is needed.
## Final Plan Rationale
Explain why the task split, dependencies, validation commands, assumptions, and open questions are appropriate.

Allowed verdicts: planned, needs_human, blocked.
Allowed task statuses in planner output: pending, needs_human, blocked.
Allowed task kinds: discovery, investigation, implementation, architecture, maintenance, handoff.
Each task must have: id, title, kind, workflow, status, priority, acceptanceCriteria, validation, dependsOn, failureHistory, artifacts.
Use one workflow per task. Use dependencies for workflow sequences. Use only canonical workflows from the policy.
Keep tasks small and independently verifiable: one logical change, one primary artifact/change area, and focused validation. Split broad goals into dependent tasks. If safe slicing is unclear or a task would need multiple unrelated changes, record the uncertainty in openQuestions or needs_human rather than creating a broad task.

Planner result schema:
{
  "verdict": "planned|needs_human|blocked",
  "summary": "...",
  "decisions": [],
  "assumptions": [],
  "openQuestions": [],
  "blockers": [],
  "tasks": [],
  "artifacts": ["path/to/grill-transcript.md"]
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

function New-ExecutorPrompt($Task, [int]$Iteration, [string]$PromptFile, [string]$RunDir, [string]$CodeGraphFile = "") {
    $taskJson = $Task | ConvertTo-Json -Depth 20
    $workflow = if ($Task.workflow) { [string]$Task.workflow } else { "tdd" }
    $kind = if ($Task.kind) { [string]$Task.kind } else { "implementation" }
    $recentHistory = Get-RecentAgenticHistory
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
- Before finishing, write a concise handover note to `$RunDir/handover.md` with: what changed, key files, validation run, gotchas, and next-task notes.
- For discovery/investigation tasks, useful artifact files may be the main output; code changes are not required unless the task asks for them.
- For implementation/architecture/maintenance tasks, prefer tracked repo changes plus validation unless the task is explicitly artifact-only.
- When you add a focused smoke test/check that proves this task, use or propose it as a task.validation command (for example `pwsh -File tests/path/focused-smoke.ps1`) so the harness runs it before verification.
- Use `pwsh -File` in harness and smoke-test command examples. Mention `powershell.exe` only as a legacy Windows PowerShell compatibility fallback when explicitly needed.

Iteration: $Iteration
State file: $stateFile
Selected workflow: $workflow
Task kind: $kind
Run directory: $RunDir
CodeGraph context: $CodeGraphFile

Use CodeGraph context for orientation before broad manual search, especially for dependency/call relationship questions. Verify conclusions by reading source files. If CodeGraph is unavailable, continue normally.

Recent harness history (JSONL tail; source of truth is $eventLogPath):
$recentHistory

$(Get-WorkflowBlock $workflow)

Task JSON:
$taskJson
"@
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PromptFile) | Out-Null
    Set-Content -LiteralPath $PromptFile -Value $content -Encoding UTF8
}

function Invoke-FinalizeDocsIfNeeded {
    if (!$finalizeDocs) { Write-AgenticEvent "finalize_docs_skipped" @{ reason = "no-finalize-docs" }; return }
    if (!$merge) { Write-AgenticEvent "finalize_docs_skipped" @{ reason = "changes-not-merged" }; return }
    if (!(Test-Path -LiteralPath "PROJECT.md") -and !(Test-Path -LiteralPath "CONTEXT.md")) { Write-AgenticEvent "finalize_docs_skipped" @{ reason = "no-project-or-context-md" }; return }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $finalizeRunDir = Join-Path $runsRoot "agentic-$timestamp-finalize-docs"
    $finalizeRunDirAbs = Join-Path (Resolve-Path -LiteralPath ".").Path $finalizeRunDir
    $promptFile = Join-Path $finalizeRunDirAbs "finalize-docs.md"
    $logFile = Join-Path $finalizeRunDirAbs "finalize-docs.log"
    $summaryFile = Join-Path $finalizeRunDirAbs "final-summary.md"
    New-Item -ItemType Directory -Force -Path $finalizeRunDirAbs | Out-Null

    $stateJson = (Read-StateJson) | ConvertTo-Json -Depth 20
    $recentHistory = Get-RecentAgenticHistory 30
    $diffStat = (& git diff --stat HEAD) -join "`n"
    $projectState = if (Test-Path -LiteralPath "PROJECT.md") { "PROJECT.md exists" } else { "PROJECT.md missing" }
    $contextState = if (Test-Path -LiteralPath "CONTEXT.md") { "CONTEXT.md exists (planning-stage grill-with-docs ownership)" } else { "CONTEXT.md missing" }
    $content = @"
You are finalizing a completed agentic loop run.

Goal: update durable repository markdowns only when the completed work changed durable facts.

Rules:
- Use the canonical update-project-md behavior for PROJECT.md.
- Update PROJECT.md for technical facts: commands, architecture, validation, workflows, debugging, file roles, setup changes.
- Do not normally edit CONTEXT.md here; CONTEXT.md belongs to the planning grill-with-docs stage. Only touch it if execution discovered a durable domain/product fact that could not have been known during planning, and explain that exception in the final summary.
- Do not edit AGENTS.md or CLAUDE.md unless the task explicitly changed agent policy.
- Keep edits concise and factual. Do not add transient run logs.
- If no durable docs need changes, leave the markdown files unchanged and explain why in the final summary.
- Always write a final human checkpoint summary to: $summaryFile

Docs available:
- $projectState
- $contextState

Agentic state:
$stateJson

Recent harness events:
$recentHistory

Current uncommitted diff stat before doc finalization:
$diffStat
"@
    Set-Content -LiteralPath $promptFile -Value $content -Encoding UTF8
    Write-AgenticEvent "finalize_docs_started" @{ runDir = $finalizeRunDir; prompt = $promptFile; summary = $summaryFile }
    Invoke-AgentWithLog $promptFile $commandTemplate "" $logFile
    if (!(Test-Path -LiteralPath $summaryFile)) {
        Set-Content -LiteralPath $summaryFile -Value "# Agentic final summary`n`nFinalizer did not create a summary; inspect $logFile." -Encoding UTF8
    }
    $docChanges = (& git status --porcelain -- PROJECT.md)
    if ($docChanges -and $commit) {
        Invoke-CheckedNative git @("add", "PROJECT.md")
        Invoke-CheckedNative git @("commit", "-m", "agentic: finalize docs")
    }
    Write-AgenticEvent "finalize_docs_finished" @{ runDir = $finalizeRunDir; summary = $summaryFile; docsChanged = [bool]$docChanges }
}

function Complete-AgenticRun {
    Invoke-FinalizeDocsIfNeeded
    Write-Output "<promise>COMPLETE</promise>"
}

function New-VerifierPrompt($Task, [string]$WorktreePath, [string]$CheckOutput, [string]$ResultFile, [string]$PromptFile) {
    $taskJson = $Task | ConvertTo-Json -Depth 20
    $diffStat = (& git -C $WorktreePath diff --stat HEAD)
    $diff = (& git -C $WorktreePath diff HEAD)
    $gates = if ($policy -and $policy.humanGates) { ($policy.humanGates | ConvertTo-Json -Depth 10) } else { "[]" }
    $recentHistory = Get-RecentAgenticHistory
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

Recent harness history (JSONL tail; source of truth is $eventLogPath):
$recentHistory

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
    $grillTranscriptFile = Join-Path $plannerRunDir "grill-transcript.md"
    $codeGraphFile = Join-Path $plannerRunDir "codegraph.md"
    $plannerResultForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $plannerResultFile
    $repoContextForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $repoContextFile
    $grillTranscriptForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $grillTranscriptFile

    New-CodeGraphContext $codeGraphFile "."
    $codeGraphForPrompt = Join-Path (Resolve-Path -LiteralPath ".").Path $codeGraphFile
    New-RepoContext $repoContextFile $codeGraphForPrompt
    New-PlannerPrompt $promptFile $plannerResultForPrompt $repoContextForPrompt $grillTranscriptForPrompt $codeGraphForPrompt
    Write-AgenticEvent "planner_started" @{ runDir = $plannerRunDir; prompt = $promptFile; resultFile = $plannerResultFile; grillTranscript = $grillTranscriptFile }
    Write-Host "=== Agentic planner ==="
    Invoke-Agent $promptFile $commandTemplate ""
    if (!(Test-Path -LiteralPath $plannerResultFile)) { throw "Planner did not write $plannerResultFile" }
    if (!(Test-Path -LiteralPath $grillTranscriptFile)) { throw "Planner did not write $grillTranscriptFile" }
    $plannerResult = Get-Content -LiteralPath $plannerResultFile -Raw | ConvertFrom-Json
    $plannerErrors = @(Test-PlannerResult $plannerResult)
    if ($plannerErrors.Count -gt 0) {
        $repairPrompt = Join-Path $plannerRunDir "planner-repair.md"
        $errorText = ($plannerErrors -join "`n")
        $original = Get-Content -LiteralPath $plannerResultFile -Raw
        $repairContent = @"
Your previous planner-result.json was invalid.

Validation errors:
$errorText

Original planner result:
$original

Rewrite valid planner JSON only to: $plannerResultForPrompt
Follow the schema and policy from the original planner prompt at: $promptFile
"@
        Set-Content -LiteralPath $repairPrompt -Value $repairContent -Encoding UTF8
        Write-Host "=== Agentic planner repair ==="
        Invoke-Agent $repairPrompt $commandTemplate ""
        if (!(Test-Path -LiteralPath $plannerResultFile)) { throw "Planner repair did not write $plannerResultFile" }
        $plannerResult = Get-Content -LiteralPath $plannerResultFile -Raw | ConvertFrom-Json
        $plannerErrors = @(Test-PlannerResult $plannerResult)
        if ($plannerErrors.Count -gt 0) { throw "Planner result invalid after repair:`n$($plannerErrors -join "`n")" }
    }
    Write-AgenticEvent "planner_finished" @{ runDir = $plannerRunDir; verdict = [string]$plannerResult.verdict; resultFile = $plannerResultFile; grillTranscript = $grillTranscriptFile }
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
        Complete-AgenticRun
        exit 0
    }

    $taskId = if ($task.id) { [string]$task.id } else { "task-$iteration" }
    $safeId = ConvertTo-SafeSlug $taskId
    $branch = if ($reviewBranchMode) { "agentic/review/$safeId" } else { "agentic/$safeId" }
    $worktreePath = Join-Path $worktreeRoot $safeId
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $runDir = Join-Path $runsRoot "agentic-$timestamp-$safeId"
    $runDirAbs = Join-Path (Resolve-Path -LiteralPath ".").Path $runDir
    $executorPrompt = Join-Path $runDirAbs "executor.md"
    $verifierPrompt = Join-Path $runDirAbs "verifier.md"
    $verifierResult = Join-Path $runDirAbs "verifier-result.json"
    $codeGraphFile = Join-Path $runDirAbs "codegraph.md"
    $executorLog = Join-Path $runDirAbs "executor.log"
    $checksLog = Join-Path $runDirAbs "checks.log"
    $verifierLog = Join-Path $runDirAbs "verifier.log"
    $handoverFile = Join-Path $runDirAbs "handover.md"
    $stateBefore = Join-Path $runDirAbs "state-before.json"
    $stateAfter = Join-Path $runDirAbs "state-after.json"
    $verifierResultForPrompt = $verifierResult

    Write-Host "=== Agentic iteration $iteration/$maxIterationsValue`: $taskId ==="
    Write-AgenticEvent "iteration_started" @{ task = $taskId; iteration = $iteration; runDir = $runDir; branch = $branch; worktree = $worktreePath }
    New-Item -ItemType Directory -Force -Path $runDirAbs | Out-Null
    Copy-Item -LiteralPath $stateFile -Destination $stateBefore -Force
    Add-TaskAttempt $taskId $runDir
    $task = Get-Tasks (Read-StateJson) | Where-Object { [string]$_.id -eq $taskId } | Select-Object -First 1
    Set-TaskStatus $taskId "running"

    if (!(Test-Path -LiteralPath $worktreePath)) {
        Invoke-CheckedNative git @("worktree", "add", "-b", $branch, $worktreePath, "HEAD")
    }

    New-CodeGraphContext $codeGraphFile $worktreePath
    New-ExecutorPrompt $task $iteration $executorPrompt $runDir $codeGraphFile
    try {
        Write-AgenticEvent "executor_started" @{ task = $taskId; prompt = $executorPrompt; log = $executorLog }
        try { Invoke-AgentWithLog $executorPrompt $commandTemplate $worktreePath $executorLog; Write-AgenticEvent "executor_passed" @{ task = $taskId; log = $executorLog } }
        catch {
            Write-AgenticEvent "executor_failed" @{ task = $taskId; reason = $_.Exception.Message; log = $executorLog }
            Set-TaskStatus $taskId "needs_human" ([pscustomobject]@{ at = (Get-Date -Format o); phase = "executor"; reason = $_.Exception.Message; resultFile = $verifierResult })
            Write-ChecksLog $checksLog "Checks not run because executor failed."
            Write-DiffArtifacts $worktreePath $runDirAbs
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Executor failed for $taskId. Worktree retained at $worktreePath. $($_.Exception.Message)"
            exit 1
        }

        $taskChecks = Get-TaskChecks $task
        Write-AgenticEvent "checks_started" @{ task = $taskId; commands = @($taskChecks); log = $checksLog }
        try {
            $checkOutput = Invoke-Checks $worktreePath $taskChecks
            Write-ChecksLog $checksLog $checkOutput
            $checkMetrics = Parse-MetricLines $checkOutput
            Write-AgenticEvent "checks_passed" @{ task = $taskId; log = $checksLog; metrics = (ConvertTo-MetricObject $checkMetrics) }
        }
        catch {
            $checkOutput = $_.Exception.Message
            Write-ChecksLog $checksLog $checkOutput
            $failureStatus = Get-FailureStatusForTask $task "checks"
            $checkMetrics = Parse-MetricLines $checkOutput
            Write-AgenticEvent "checks_failed" @{ task = $taskId; status = $failureStatus; reason = $_.Exception.Message; log = $checksLog; metrics = (ConvertTo-MetricObject $checkMetrics) }
            Set-TaskStatus $taskId $failureStatus ([pscustomobject]@{ at = (Get-Date -Format o); phase = "checks"; reason = $_.Exception.Message; resultFile = $verifierResult })
            Write-DiffArtifacts $worktreePath $runDirAbs
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Complete-RetryableFailure $taskId $failureStatus "Checks failed for $taskId; marked $failureStatus. Worktree retained at $worktreePath. $($_.Exception.Message)"
            continue
        }

        Write-DiffArtifacts $worktreePath $runDirAbs
        if ($fastVerifier) {
            $result = [pscustomobject]@{ verdict = "pass"; summary = "fast-verifier: checks passed; separate verifier skipped by explicit operator flag"; issues = @(); humanGates = @(); recommendedStatus = "passed"; artifacts = @() }
            $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $verifierResult -Encoding UTF8
            Set-Content -LiteralPath $verifierLog -Value "fast-verifier: skipped separate verifier after checks passed." -Encoding UTF8
            Write-AgenticEvent "verifier_skipped" @{ task = $taskId; resultFile = $verifierResult; log = $verifierLog; reason = "fast-verifier" }
        } else {
            New-VerifierPrompt $task $worktreePath $checkOutput $verifierResultForPrompt $verifierPrompt
            $verifierTemplate = if (![string]::IsNullOrWhiteSpace($verifierCommandTemplate)) { $verifierCommandTemplate } else { $commandTemplate }
            Write-AgenticEvent "verifier_started" @{ task = $taskId; prompt = $verifierPrompt; resultFile = $verifierResult; log = $verifierLog }
            Invoke-AgentWithLog $verifierPrompt $verifierTemplate $worktreePath $verifierLog
            if (!(Test-Path -LiteralPath $verifierResult)) { throw "Verifier did not write $verifierResult" }
            $result = Get-Content -LiteralPath $verifierResult -Raw | ConvertFrom-Json
        }
        $verdict = [string]$result.verdict
        Write-AgenticEvent "verifier_finished" @{ task = $taskId; verdict = $verdict; summary = [string]$result.summary; resultFile = $verifierResult }
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
            if ($reviewBranchMode) { Set-TaskPassed $taskId $result $branch $worktreePath }
            else { Set-TaskPassed $taskId $result }
            if (!$merge -and $autoAcceptPassed) {
                try { Invoke-AcceptTask $taskId $true }
                catch {
                    Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
                    Write-Error "Auto-accept failed for $taskId. Worktree retained at $worktreePath and branch '$branch' remains for recovery. $($_.Exception.Message)"
                    exit 1
                }
            }
            if (!(Test-Path -LiteralPath $handoverFile)) {
                $diffStatForHandover = if (Test-Path -LiteralPath (Join-Path $runDirAbs "diff-stat.txt")) { Get-Content -LiteralPath (Join-Path $runDirAbs "diff-stat.txt") -Raw } else { "" }
                $handoverContent = @"
# Task handover: $taskId

## Summary
$($result.summary)

## Validation
See checks log: $checksLog
Verifier result: $verifierResult

## Changed files
$diffStatForHandover

## Next-task notes
No executor-authored handover was found, so the harness generated this fallback from verifier/check artifacts.
"@
                Set-Content -LiteralPath $handoverFile -Value $handoverContent -Encoding UTF8
            }
            Write-AgenticEvent "task_handover_written" @{ task = $taskId; path = $handoverFile }
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Add-Content -Path (Join-Path $runsRoot "agentic-progress.txt") -Value "`n## $(Get-Date -Format o) $taskId`n- Verdict: pass`n- Summary: $($result.summary)`n- Handover: $handoverFile"
            if ($cleanupPassed -and (Test-Path -LiteralPath $worktreePath)) { Invoke-CheckedNative git @("worktree", "remove", $worktreePath) }
            if (![string]::IsNullOrWhiteSpace($retryTaskId)) { Write-Output "<promise>COMPLETE</promise>"; exit 0 }
        } elseif ($verdict -eq "needs_human") {
            Set-TaskStatus $taskId "needs_human" ([pscustomobject]@{ at = (Get-Date -Format o); phase = "verifier"; reason = $result.summary; resultFile = $verifierResult })
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Write-Error "Verifier returned needs_human for $taskId. Worktree retained at $worktreePath."
            exit 1
        } else {
            $failureStatus = Get-FailureStatusForTask $task "verifier"
            Set-TaskStatus $taskId $failureStatus ([pscustomobject]@{ at = (Get-Date -Format o); phase = "verifier"; reason = $result.summary; resultFile = $verifierResult })
            Copy-Item -LiteralPath $stateFile -Destination $stateAfter -Force
            Complete-RetryableFailure $taskId $failureStatus "Verifier failed $taskId; marked $failureStatus. Worktree retained at $worktreePath."
            continue
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
    Complete-AgenticRun
    exit 0
}

$progress = Get-TaskProgressSummary $state
Write-Error "Reached max iterations ($maxIterationsValue) with unfinished tasks after a partial run: completed $($progress.Completed) of $($progress.Total) tasks; $($progress.Unfinished) unfinished. This is budget exhaustion, not a harness crash. Re-run with a higher --max-iterations value to continue remaining work."
exit 1
