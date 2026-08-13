@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title LLM Radar Windows Setup

set "LOGDIR=%~dp0tools\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LAUNCHLOG=%LOGDIR%\start_here_launcher.log"
>>"%LAUNCHLOG%" echo %date% %time% LLM Radar Start_Here 0.4.9g launched from %~dp0

if not exist "%~dp0tools\Run_Command_Setup_Advanced.bat" (
  cls
  echo.
  echo LLM Radar setup cannot continue.
  echo.
  echo Missing tools\Run_Command_Setup_Advanced.bat.
  echo Extract the full LLM Radar package to a normal folder, then run Start_Here again.
  echo.
  echo No firewall or network changes were made.
  echo.
  pause
  exit /b 2
)

cls
echo.
echo LLM Radar Windows Setup
echo.
echo Opening the safest command-window setup path.
echo This prepares Phone Access for QR pairing, chat/status, and small PDF/TXT upload.
echo.
echo No public access, no all-ports access, and Windows Firewall will not be disabled.
echo.
>>"%LAUNCHLOG%" echo %date% %time% Routing Start_Here through command-window setup path.
call "%~dp0tools\Run_Command_Setup_Advanced.bat"
set "RC=%ERRORLEVEL%"
>>"%LAUNCHLOG%" echo %date% %time% Command-window setup exited with code %RC%.
exit /b %RC%
