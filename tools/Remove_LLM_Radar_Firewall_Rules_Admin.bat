@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0\.."
title LLM Radar Firewall Rule Cleanup

call :FIND_POWERSHELL

if /I "%~1"=="--elevated" goto RUN_ELEVATED

cls
echo.
echo ==============================================
echo   LLM Radar Firewall Rule Cleanup
echo ==============================================
echo.
echo This removes firewall rules created by LLM Radar only.
echo It will not remove unrelated Windows, Ollama, Node.js, or user rules.
echo.

if not defined PS_EXE (
  echo ERROR: This command window cannot find Windows PowerShell.
  echo Cleanup stopped before making any firewall changes.
  echo.
  pause
  exit /b 3
)

fltmc >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission through Windows UAC...
  echo If a UAC prompt appears, choose Yes to remove LLM Radar rules.
  echo Choosing No cancels cleanup before any firewall changes are made.
  echo.
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/k','""%~f0"" --elevated' -WorkingDirectory '%~dp0\..' -Verb RunAs"
  pause
  exit /b 0
)

goto RUN_ELEVATED

:RUN_ELEVATED
if not defined PS_EXE (
  echo ERROR: This elevated command window cannot find Windows PowerShell.
  echo Cleanup stopped before making any firewall changes.
  echo.
  pause
  exit /b 3
)
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Remove_LLM_Radar_Firewall_Rules.ps1"
echo.
pause
exit /b %ERRORLEVEL%

:FIND_POWERSHELL
set "PS_EXE="
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
if exist "%WINDIR%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%WINDIR%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
if exist "%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PS_EXE exit /b 0
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if defined PS_EXE exit /b 0
where powershell.exe >nul 2>&1 && set "PS_EXE=powershell.exe"
if defined PS_EXE exit /b 0
where pwsh.exe >nul 2>&1 && set "PS_EXE=pwsh.exe"
exit /b 0
