@echo off
setlocal
where.exe pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell 7 was not found. Install PowerShell 7 and add pwsh.exe to PATH.
  pause
  exit /b 1
)
if not exist "%~dp0bartender-agent.ps1" (
  echo Missing bartender-agent.ps1. Save the CMD and PS1 from the same version in one folder.
  pause
  exit /b 1
)
if "%~1"=="" (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bartender-agent.ps1" -Console
) else (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bartender-agent.ps1" %*
)
set "LABOS_AGENT_EXIT=%ERRORLEVEL%"
echo.
if not "%LABOS_AGENT_EXIT%"=="0" echo Printing helper stopped with exit code %LABOS_AGENT_EXIT%. Review the error above.
pause
exit /b %LABOS_AGENT_EXIT%
