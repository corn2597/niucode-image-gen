@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul

set "REPOSITORY=niucodes/niucode-image-gen"
set "MANIFEST_URL=https://gitee.com/%REPOSITORY%/raw/main/release-version.txt"
set "TEMP_ROOT=%TEMP%\niucodes-image-gen-%RANDOM%%RANDOM%"
set "VERSION_FILE=%TEMP_ROOT%\release-version.txt"
set "UNPACK_DIR=%TEMP_ROOT%\unpacked"
set "CODEX_ROOT=%USERPROFILE%\.codex"
set "SKILL_DIR=%CODEX_ROOT%\skills\niucodes-image-gen"
set "EXIT_CODE=1"

where curl.exe >nul 2>&1 || (
  echo Error: Windows curl.exe is required. Please use Windows 10 or later.
  goto cleanup
)
where tar.exe >nul 2>&1 || (
  echo Error: Windows tar.exe is required. Please use Windows 10 or later.
  goto cleanup
)
where certutil.exe >nul 2>&1 || (
  echo Error: Windows certutil.exe is required.
  goto cleanup
)

mkdir "%TEMP_ROOT%" >nul 2>&1 || (
  echo Error: Could not create a temporary directory.
  goto cleanup
)

echo Downloading the latest release information...
curl.exe --fail --location --silent --show-error "%MANIFEST_URL%" --output "%VERSION_FILE%"
if errorlevel 1 (
  echo Error: Could not download the release information.
  goto cleanup
)

set "TAG="
for /f "usebackq delims=" %%V in ("%VERSION_FILE%") do if not defined TAG set "TAG=%%V"
echo(%TAG%| findstr /R /X "v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
  echo Error: The release information is invalid.
  goto cleanup
)

set "ARCHIVE_NAME=niucodes-image-gen-win-x64-%TAG%.zip"
set "ARCHIVE_URL=https://gitee.com/%REPOSITORY%/releases/download/%TAG%/%ARCHIVE_NAME%"
set "CHECKSUM_URL=https://gitee.com/%REPOSITORY%/releases/download/%TAG%/SHA256SUMS.txt"
set "ARCHIVE_PATH=%TEMP_ROOT%\%ARCHIVE_NAME%"
set "CHECKSUM_PATH=%TEMP_ROOT%\SHA256SUMS.txt"

echo Downloading %ARCHIVE_NAME%...
curl.exe --fail --location --silent --show-error "%ARCHIVE_URL%" --output "%ARCHIVE_PATH%"
if errorlevel 1 (
  echo Error: Could not download the Windows package.
  goto cleanup
)
curl.exe --fail --location --silent --show-error "%CHECKSUM_URL%" --output "%CHECKSUM_PATH%"
if errorlevel 1 (
  echo Error: Could not download SHA256SUMS.txt.
  goto cleanup
)

set "EXPECTED_SHA="
rem Parse the standard SHA256SUMS format by columns instead of using findstr
rem regular expressions. Windows findstr behaves inconsistently for character
rem ranges on some localized installations.
for /f "tokens=1,2" %%H in ('type "%CHECKSUM_PATH%"') do (
  if /I "%%I"=="%ARCHIVE_NAME%" set "EXPECTED_SHA=%%H"
  if /I "%%I"=="*%ARCHIVE_NAME%" set "EXPECTED_SHA=%%H"
)
set "ACTUAL_SHA="
for /f "tokens=1" %%H in ('certutil.exe -hashfile "%ARCHIVE_PATH%" SHA256 ^| findstr /R /X "[0-9A-Fa-f][0-9A-Fa-f]*"') do set "ACTUAL_SHA=%%H"
if not defined EXPECTED_SHA (
  echo Error: SHA256SUMS.txt does not contain the Windows package checksum.
  goto cleanup
)
if not defined ACTUAL_SHA (
  echo Error: Could not calculate the package SHA-256.
  goto cleanup
)
if /I not "%EXPECTED_SHA%"=="%ACTUAL_SHA%" (
  echo Error: SHA-256 verification failed.
  goto cleanup
)

mkdir "%UNPACK_DIR%" >nul 2>&1
tar.exe -xf "%ARCHIVE_PATH%" -C "%UNPACK_DIR%"
if errorlevel 1 (
  echo Error: Could not unpack the Windows package.
  goto cleanup
)

set "PACKAGE_DIR=%UNPACK_DIR%\niucodes-image-gen-win-x64"
set "EXECUTABLE=%PACKAGE_DIR%\bin\niucodes-image-gen-win-x64.exe"
if not exist "%EXECUTABLE%" (
  echo Error: The release package has an unexpected layout.
  goto cleanup
)

"%EXECUTABLE%" install --install-dir "%SKILL_DIR%" --config-path "%CODEX_ROOT%\config.toml" --prompt-api-key
if errorlevel 1 (
  echo Error: Installation failed.
  goto cleanup
)

echo.
echo Installation completed. Restart Codex Desktop before using the skill.
set "EXIT_CODE=0"

:cleanup
if exist "%TEMP_ROOT%" rmdir /s /q "%TEMP_ROOT%"
if "%EXIT_CODE%"=="0" (
  pause
) else (
  echo.
  echo Installation did not complete.
  pause
)
endlocal & exit /b %EXIT_CODE%
