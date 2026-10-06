[CmdletBinding()]
param(
    [ValidateSet('setup', 'start', 'test', 'check')]
    [string]$Action = 'start',
    [string]$Python = 'python',
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoPath = $PSScriptRoot
$venvPython = Join-Path $repoPath 'backend/.venv/Scripts/python.exe'
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { throw 'Install Node.js 24.15+ (or 22.22.2+) and reopen PowerShell. npm.cmd was not found.' }
$nodeCommand = Get-Command node -ErrorAction Stop
$npmCli = Join-Path (Split-Path $npmCommand.Source) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'The npm CLI is missing. Reinstall Node.js with npm included.' }
$nodeVersion = & node -p 'JSON.stringify(process.versions.node.split(".").map(Number))' | ConvertFrom-Json
$supportedNode = ($nodeVersion[0] -eq 22 -and ($nodeVersion[1] -gt 22 -or ($nodeVersion[1] -eq 22 -and $nodeVersion[2] -ge 2))) -or ($nodeVersion[0] -eq 24 -and $nodeVersion[1] -ge 15) -or $nodeVersion[0] -ge 26
if (-not $supportedNode) { throw "Node $($nodeVersion -join '.') is unsupported. Use Node 24.15+ or 22.22.2+." }

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Executable $($Arguments -join ' ')" }
}

function Invoke-Npm {
    param([string[]]$Arguments)
    Invoke-Checked $nodeCommand.Source (@($npmCli) + $Arguments)
}

Push-Location $repoPath
try {
    if ($Action -eq 'setup') {
        Invoke-Checked $Python @('-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"')
        if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-Checked $Python @('-m', 'venv', 'backend/.venv') }
        Invoke-Checked $venvPython @('-m', 'ensurepip', '--upgrade')
        Invoke-Checked $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
        Invoke-Checked $venvPython @('-m', 'pip', 'install', '-r', 'backend/requirements.txt')
        Invoke-Npm @('ci', '--prefix', 'frontend', '--no-audit', '--no-fund')
    Write-Host 'Setup complete. Run .\octopus.ps1 start to build and serve Octopus.'
        return
    }
    if (-not (Test-Path -LiteralPath $venvPython)) { throw 'Backend is not installed. Run .\octopus.ps1 setup first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'frontend/node_modules'))) { throw 'Frontend is not installed. Run .\octopus.ps1 setup first.' }
    if ($Action -eq 'check') {
        Invoke-Checked $venvPython @('-c', 'import sys, fastapi, uvicorn; print("Python", sys.version.split()[0], "and backend dependencies are ready")')
        Write-Host "Node $($nodeVersion -join '.') and frontend dependencies are ready."
        Write-Host "Project: $repoPath"
        return
    }
    if ($Action -eq 'test') {
        Push-Location (Join-Path $repoPath 'backend')
        try { Invoke-Checked $venvPython @('-m', 'pytest', '-q') } finally { Pop-Location }
        Invoke-Npm @('run', 'typecheck', '--prefix', 'frontend')
        Invoke-Npm @('test', '--prefix', 'frontend')
        return
    }
    if (-not $SkipBuild) { Invoke-Npm @('run', 'build', '--prefix', 'frontend') }
    if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'frontend/dist/index.html'))) { throw 'The frontend build is missing. Run .\octopus.ps1 start without -SkipBuild.' }
    Write-Host "Octopus: http://127.0.0.1:$Port  (Ctrl+C to stop)"
    Push-Location (Join-Path $repoPath 'backend')
    try { Invoke-Checked $venvPython @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', [string]$Port, '--no-access-log') } finally { Pop-Location }
} finally { Pop-Location }
