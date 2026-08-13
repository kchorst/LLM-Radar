param(
  [string]$SetupPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'setup_launcher.log'

function Write-LauncherLog([string]$Message) {
  try {
    Add-Content -Path $logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message) -Encoding UTF8
  } catch {}
}

function Show-LauncherError([string]$Message) {
  Write-LauncherLog $Message
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(
      $Message + "`n`nLLM Radar did not make any firewall or network changes. Extract the full package to a normal folder and run Start_Here again. If this continues, use tools\Run_Command_Setup_Advanced.bat or share the support log with an administrator.",
      'LLM Radar Windows Setup could not start',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    try {
      Start-Process notepad.exe $logFile | Out-Null
    } catch {}
  }
}

try {
  Write-LauncherLog 'Launcher started.'
  if (-not $SetupPath) { $SetupPath = Join-Path $PSScriptRoot 'LLMRadarWindowsSetup.ps1' }
  if (-not (Test-Path $SetupPath)) { throw "Missing Windows Setup script: $SetupPath" }

  # Parse preflight catches most flash-and-exit failures before trying to open the GUI.
  try {
    $raw = Get-Content -Path $SetupPath -Raw -ErrorAction Stop
    [void][scriptblock]::Create($raw)
    Write-LauncherLog 'Windows Setup parse preflight passed.'
  } catch {
    throw "LLM Radar Windows Setup could not start because one setup file has an internal script error. $($_.Exception.Message)"
  }

  & $SetupPath
  $exit = if ($global:LASTEXITCODE -is [int]) { $global:LASTEXITCODE } else { 0 }
  Write-LauncherLog "Windows Setup exited. LASTEXITCODE=$exit"
  exit $exit
} catch {
  Show-LauncherError $_.Exception.Message
  exit 20
}
