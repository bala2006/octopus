[CmdletBinding()]
param(
    [ValidateSet('setup', 'start', 'dev', 'test', 'check')]
    [string]$Action = 'start',
    [string]$Python = 'python',
    [ValidateRange(0, 65535)]
    [int]$Port = 0,
    [switch]$SkipBuild
)

# Thin shim: everything (prerequisites, build skipping, the dev proxy, child cleanup) lives in backend/app/cli.py.
$ErrorActionPreference = 'Stop'
$repoPath = $PSScriptRoot
$venvPython = Join-Path $repoPath 'backend/.venv/Scripts/python.exe'
$interpreter = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { $Python }

$arguments = @('-m', 'app.cli', $Action, '--python', $Python)
if ($Port -gt 0) { $arguments += @('--port', [string]$Port) }
if ($SkipBuild) { $arguments += '--skip-build' }

Push-Location (Join-Path $repoPath 'backend')
try {
    & $interpreter @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
