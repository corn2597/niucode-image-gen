$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runner = Join-Path $repoRoot "scripts\invoke-imagegen.ps1"
$hostExe = (Get-Process -Id $PID).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("niucodes imagegen runner " + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Has-ImageOption($Captured, [string]$Name) {
    $values = @($Captured)
    return (($values -contains "--$Name") -or ($values -contains "-$Name"))
}

function Invoke-RunnerCase([string]$Mode, [int]$TimeoutSeconds = 5, [bool]$UseSingleDashAliases = $false) {
    $caseRoot = Join-Path $tempRoot ("case with spaces " + $Mode)
    [System.IO.Directory]::CreateDirectory($caseRoot) | Out-Null
    $statusFile = Join-Path $caseRoot "final status.json"
    $stdoutFile = Join-Path $caseRoot "runner stdout.json"
    $stderrFile = Join-Path $caseRoot "runner stderr.log"
    $captureFile = Join-Path $caseRoot "captured args.json"
    $historyFile = Join-Path $caseRoot "status history.txt"
    $outputFile = Join-Path $caseRoot "output image.png"
    $mockFile = Join-Path $caseRoot "mock imagegen.ps1"
    $mockCommand = Join-Path $caseRoot "mock imagegen.cmd"
    @'
param([string]$MockMode)
$ErrorActionPreference = "Stop"
function ArgValue([string]$Name) {
    $names = @($Name)
    if ($Name.StartsWith("--")) { $names += "-" + $Name.Substring(2) }
    foreach ($candidate in $names) {
        $index = [Array]::IndexOf([string[]]$args, $candidate)
        if ($index -ge 0 -and $index + 1 -lt $args.Length) { return $args[$index + 1] }
    }
    return $null
}
function Write-Status([string]$Path, [string]$State, [int]$ExitCode) {
    $payload = [ordered]@{
        version = 1; status = $State; command = $args[0]; exit_code = $ExitCode
        saved = @(); timing_ms = @{ input_prepare = 0; api = 1; save = 0; total = 1 }
        error = if ($State -eq "failed") { @{ message = "mock failed" } } else { $null }
        request_id = "mock-request"
    }
    [System.IO.File]::WriteAllText($Path, ($payload | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}
$statusFile = ArgValue "--status-file"
$caseRoot = Split-Path -Parent $statusFile
$captureFile = Join-Path $caseRoot "captured args.json"
$historyFile = Join-Path $caseRoot "status history.txt"
[System.IO.File]::WriteAllText($captureFile, ($args | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
Write-Status $statusFile "running" 0
[System.IO.File]::WriteAllText($historyFile, "running", (New-Object System.Text.UTF8Encoding($false)))
if ($MockMode -eq "slow") { Start-Sleep -Seconds 4; exit 0 }
Start-Sleep -Milliseconds 150
if ($MockMode -eq "failed") { Write-Status $statusFile "failed" 7; exit 7 }
$payload = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
$payload.status = "success"; $payload.exit_code = 0
$payload.saved = @(@{ index = 0; absolute_path = (ArgValue "--output"); markdown_path = "mock.png"; markdown = "![mock](mock.png)"; revised_prompt = $null })
[System.IO.File]::WriteAllText($statusFile, ($payload | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::AppendAllText($historyFile, ",success", (New-Object System.Text.UTF8Encoding($false)))
exit 0
'@ | Set-Content -LiteralPath $mockFile -Encoding UTF8
    @"
@echo off
"$hostExe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0mock imagegen.ps1" -MockMode "$Mode" --% %*
"@ | Set-Content -LiteralPath $mockCommand -Encoding ASCII

    $prompt = '中文 prompt with spaces and "quoted text"'
    $promptFlag = if ($UseSingleDashAliases) { "-Prompt" } else { "--prompt" }
    $outputFlag = if ($UseSingleDashAliases) { "-Output" } else { "--output" }
    $qualityFlag = if ($UseSingleDashAliases) { "-Quality" } else { "--quality" }
    $sizeFlag = if ($UseSingleDashAliases) { "-Size" } else { "--size" }
    $overwriteFlag = if ($UseSingleDashAliases) { "-Overwrite" } else { "--overwrite" }
    $runnerArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runner,
        "generate", "--status-file", $statusFile, "--timeout-seconds", $TimeoutSeconds,
        "-ExecutablePath", $mockCommand,
        $promptFlag, $prompt,
        $outputFlag, $outputFile, $qualityFlag, "low", $sizeFlag, "1024x1024", $overwriteFlag, "true"
    )
    & $hostExe @runnerArguments 1> $stdoutFile 2> $stderrFile
    $exitCode = $LASTEXITCODE
    return [ordered]@{
        exit_code = $exitCode
        result = Get-Content -LiteralPath $stdoutFile -Raw -Encoding UTF8 | ConvertFrom-Json
        status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        captured = Get-Content -LiteralPath $captureFile -Raw -Encoding UTF8 | ConvertFrom-Json
        history = Get-Content -LiteralPath $historyFile -Raw -Encoding UTF8
        stdout = Get-Content -LiteralPath $stdoutFile -Raw -Encoding UTF8
    }
}

try {
    $success = Invoke-RunnerCase "success"
    Assert-True ($success.exit_code -eq 0) "success exit code"
    Assert-True ($success.result.status -eq "success") "success stdout result"
    Assert-True ($success.status.status -eq "success") "success final status"
    Assert-True ($success.history -eq "running,success") "status transition"
    Assert-True ($success.stdout.TrimStart().StartsWith("{")) "stdout must be JSON"
    Assert-True (($success.captured -join "|") -match "中文 prompt with spaces") "UTF-8 prompt was not preserved"
    Assert-True (($success.captured -join "|") -match 'quoted text') "quoted argument was not preserved"

    $aliases = Invoke-RunnerCase "success" 5 $true
    Assert-True ($aliases.exit_code -eq 0) "single-dash alias exit code"
    Assert-True (Has-ImageOption $aliases.captured "prompt") "-Prompt was not normalized"
    Assert-True (Has-ImageOption $aliases.captured "output") "-Output was not normalized"
    Assert-True (Has-ImageOption $aliases.captured "quality") "-Quality was not normalized"
    Assert-True (Has-ImageOption $aliases.captured "size") "-Size was not normalized"
    Assert-True (Has-ImageOption $aliases.captured "overwrite") "-Overwrite was not normalized"
    Assert-True (-not (($aliases.captured -join "|") -match '(^|\|)-Prompt(\||$)')) "-Prompt reached the executable"
    Assert-True (($aliases.captured -join "|") -match "中文 prompt with spaces") "single-dash UTF-8 prompt was not preserved"

    $failed = Invoke-RunnerCase "failed"
    Assert-True ($failed.exit_code -eq 7) "failed exit code"
    Assert-True ($failed.result.status -eq "failed") "failed stdout result"
    Assert-True ($failed.status.status -eq "failed") "failed final status"

    $timeout = Invoke-RunnerCase "slow" 1
    Assert-True ($timeout.exit_code -eq 124) "timeout exit code"
    Assert-True ($timeout.result.status -eq "failed") "timeout stdout result"
    Assert-True ($timeout.result.error.message -match "Timed out") "timeout error"
    Write-Output "invoke-imagegen.ps1 tests passed"
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
