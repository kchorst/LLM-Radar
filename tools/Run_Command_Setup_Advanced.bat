@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0.."
title LLM Radar Windows Setup

set "LOGDIR=%cd%\tools\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LAUNCHLOG=%LOGDIR%\command_setup_launcher.log"
>>"%LAUNCHLOG%" echo %date% %time% Command-window setup launched from %cd%

echo.
echo LLM Radar Windows Setup
echo.
echo This safe command-window setup prepares this computer for phone access.
echo It covers QR pairing, chat/status, and small PDF/TXT upload on one selected LLM Radar port.
echo.
echo Safety: Private network only, no public access, no all-ports access,
echo and Windows Firewall is not disabled.
echo.

call :FIND_POWERSHELL
if not defined PS_EXE (
  echo ERROR: Windows PowerShell was not found.
  echo No firewall or network changes were made.
  echo.
  pause
  exit /b 3
)

fltmc >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission for the required Windows setup step...
  echo Approve the Windows prompt, then continue in the new setup window.
  >>"%LAUNCHLOG%" echo %date% %time% Requesting elevation.
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/k','""%~f0"" --elevated' -WorkingDirectory '%cd%' -Verb RunAs"
  exit /b 0
)

if not exist "%cd%\tools\llmradar-admin-setup.ps1" (
  echo ERROR: Missing tools\llmradar-admin-setup.ps1.
  echo Extract the full package to a normal folder, then run Start_Here again.
  echo No firewall or network changes were made.
  echo.
  pause
  exit /b 4
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%cd%\tools\llmradar-admin-setup.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo LLM Radar setup finished with code %RC%.
echo Keep this window open if Phone Access is running.
echo.
pause
exit /b %RC%

:FIND_POWERSHELL
set "PS_EXE="
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
where powershell.exe >nul 2>&1 && set "PS_EXE=powershell.exe"
exit /b 0
