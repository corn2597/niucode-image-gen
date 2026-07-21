@echo off
setlocal

set "ROOT=%~dp0.."
set "EXECUTABLE=%ROOT%\bin\niucodes-image-gen-win-x64.exe"

if not exist "%EXECUTABLE%" (
  echo Bundled Windows executable was not found.
  pause
  exit /b 1
)

"%EXECUTABLE%" install
if errorlevel 1 (
  echo Installation failed.
  pause
  exit /b 1
)

echo.
echo Installation completed. Restart Codex Desktop before using the skill.
pause
