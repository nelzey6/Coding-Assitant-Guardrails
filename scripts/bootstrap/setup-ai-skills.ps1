param(
    [ValidateSet("Codex", "Claude", "Both")]
    [string]$Tool = "Both",
    [string]$SkillsRepo = "",
    [string]$Destination = "",
    [switch]$Update = $true,
    [switch]$NoUpdate
)

$ErrorActionPreference = "Stop"
if ($NoUpdate) {
    $Update = $false
}

function Install-SkillFolder {
    param(
        [System.IO.DirectoryInfo]$SkillFolder,
        [string]$TargetRoot
    )

    $destination = Join-Path $TargetRoot $SkillFolder.Name

    if (Test-Path $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }

    Copy-Item -LiteralPath $SkillFolder.FullName -Destination $destination -Recurse
}

function Install-Skills {
    param(
        [string]$ToolName,
        [string]$TargetRoot,
        [System.IO.FileInfo[]]$SkillFiles
    )

    New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

    foreach ($skillFile in $SkillFiles) {
        Install-SkillFolder -SkillFolder $skillFile.Directory -TargetRoot $TargetRoot
    }

    Write-Host "Installed $($SkillFiles.Count) $ToolName skills to $TargetRoot"
}

function Copy-Template {
    param(
        [string]$Source,
        [string]$DestinationPath
    )

    if (!(Test-Path $Source)) {
        throw "Template not found: $Source"
    }

    Copy-Item -LiteralPath $Source -Destination $DestinationPath -Force
    Write-Host "Wrote $DestinationPath"
}

function Copy-TemplateIfMissing {
    param(
        [string]$Source,
        [string]$DestinationPath
    )

    if (!(Test-Path $Source)) {
        throw "Template not found: $Source"
    }

    if (Test-Path $DestinationPath) {
        Write-Host "Keeping existing $DestinationPath"
        return
    }

    Copy-Item -LiteralPath $Source -Destination $DestinationPath
    Write-Host "Created $DestinationPath"
}

function Copy-RepoTemplates {
    param(
        [string]$ToolName,
        [string]$TemplateRoot,
        [string]$DestinationRoot
    )

    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null

    if ($ToolName -eq "Codex" -or $ToolName -eq "Both") {
        Copy-Template -Source (Join-Path $TemplateRoot "AGENTS.md") -DestinationPath (Join-Path $DestinationRoot "AGENTS.md")
    }

    if ($ToolName -eq "Claude" -or $ToolName -eq "Both") {
        Copy-Template -Source (Join-Path $TemplateRoot "CLAUDE.md") -DestinationPath (Join-Path $DestinationRoot "CLAUDE.md")
    }

    Copy-TemplateIfMissing -Source (Join-Path $TemplateRoot "PROJECT.md") -DestinationPath (Join-Path $DestinationRoot "PROJECT.md")
    Copy-TemplateIfMissing -Source (Join-Path $TemplateRoot "CONTEXT.md") -DestinationPath (Join-Path $DestinationRoot "CONTEXT.md")

    $policyDestination = Join-Path $DestinationRoot ".agent-policy"
    New-Item -ItemType Directory -Force -Path $policyDestination | Out-Null
    Copy-TemplateIfMissing -Source (Join-Path $TemplateRoot "agent-policy\workflow-policy.json") -DestinationPath (Join-Path $policyDestination "workflow-policy.json")
}

function Add-GitignoreEntry {
    param(
        [string]$DestinationRoot,
        [string]$Pattern
    )

    $gitignorePath = Join-Path $DestinationRoot ".gitignore"

    if (!(Test-Path $gitignorePath)) {
        New-Item -ItemType File -Path $gitignorePath | Out-Null
    }

    $existing = Get-Content $gitignorePath -ErrorAction SilentlyContinue
    if ($existing -notcontains $Pattern) {
        Add-Content -Path $gitignorePath -Value $Pattern
        Write-Host "Added $Pattern to $gitignorePath"
    } else {
        Write-Host "$Pattern already present in $gitignorePath"
    }
}

if ([string]::IsNullOrWhiteSpace($SkillsRepo)) {
    $SkillsRepo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
} else {
    $SkillsRepo = Resolve-Path $SkillsRepo
}

if ($Update -and $env:SETUP_AI_SKILLS_REEXECED -ne "1") {
    if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "-Update requires git on PATH"
    }

    $gitDir = Join-Path $SkillsRepo ".git"
    if (!(Test-Path $gitDir)) {
        throw "-Update requires $SkillsRepo to be a git checkout"
    }

    Write-Host "Updating skills repo at $SkillsRepo using its configured git remote"
    git -C $SkillsRepo fetch --prune
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch failed in $SkillsRepo"
    }
    git -C $SkillsRepo pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        throw "git pull failed in $SkillsRepo"
    }

    $reexecArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
    if ($PSBoundParameters.ContainsKey("Tool")) { $reexecArgs += @("-Tool", $Tool) }
    if ($PSBoundParameters.ContainsKey("SkillsRepo")) { $reexecArgs += @("-SkillsRepo", $SkillsRepo) }
    if ($PSBoundParameters.ContainsKey("Destination")) { $reexecArgs += @("-Destination", $Destination) }
    if ($PSBoundParameters.ContainsKey("Update") -or !$PSBoundParameters.ContainsKey("NoUpdate")) { $reexecArgs += "-Update" }

    Write-Host "Re-running updated installer"
    $env:SETUP_AI_SKILLS_REEXECED = "1"
    $currentExe = (Get-Process -Id $PID).Path
    & $currentExe @reexecArgs
    exit $LASTEXITCODE
}

$skillsRoot = Join-Path $SkillsRepo "skills"
if (!(Test-Path $skillsRoot)) {
    throw "Skills directory not found: $skillsRoot. Run this script from the skills repository checkout or pass -SkillsRepo PATH."
}

$skillFiles = Get-ChildItem -Path $skillsRoot -Filter "SKILL.md" -Recurse -File |
    Where-Object { $_.FullName -notmatch "\\deprecated\\" -and $_.FullName -notmatch "\\node_modules\\" }

if ($skillFiles.Count -eq 0) {
    throw "No SKILL.md files found under $skillsRoot."
}

if ($Tool -eq "Codex" -or $Tool -eq "Both") {
    Install-Skills -ToolName "Codex" -TargetRoot "$env:USERPROFILE\.codex\skills" -SkillFiles $skillFiles
}

if ($Tool -eq "Claude" -or $Tool -eq "Both") {
    Install-Skills -ToolName "Claude" -TargetRoot "$env:USERPROFILE\.claude\skills" -SkillFiles $skillFiles
}

$ralphSetup = Join-Path $SkillsRepo "scripts\ralph\setup-ralph.ps1"
if (Test-Path $ralphSetup) {
    & $ralphSetup -SkillsRepo $SkillsRepo -Tool $Tool
    if (!$?) {
        throw "Ralph setup failed"
    }
}

if (![string]::IsNullOrWhiteSpace($Destination)) {
    $templateRoot = Join-Path $SkillsRepo "templates"
    if (!(Test-Path $templateRoot)) {
        throw "Templates directory not found: $templateRoot"
    }

    $destinationRoot = Resolve-Path -Path $Destination -ErrorAction SilentlyContinue
    if ($null -eq $destinationRoot) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        $destinationRoot = Resolve-Path $Destination
    }

    Copy-RepoTemplates -ToolName $Tool -TemplateRoot $templateRoot -DestinationRoot $destinationRoot
    Add-GitignoreEntry -DestinationRoot $destinationRoot -Pattern ".agent-runs/"
    Add-GitignoreEntry -DestinationRoot $destinationRoot -Pattern ".worktrees/"
    Write-Host "Repo templates copied to $destinationRoot"
}

Write-Host "Restart Codex or Claude to refresh available skills."
if ($Update) {
    Write-Host "Installed after updating $SkillsRepo. Use -Destination <repo> to overwrite templates in a product repo."
} else {
    Write-Host "Repo templates are available in $SkillsRepo\templates. Use -Destination <repo> to overwrite templates in a product repo."
}
