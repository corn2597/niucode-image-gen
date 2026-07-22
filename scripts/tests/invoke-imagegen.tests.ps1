$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runner = Join-Path $repoRoot "scripts\invoke-imagegen.ps1"
$hostExe = (Get-Process -Id $PID).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("niucodes imagegen runner " + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$mockExecutable = Join-Path $tempRoot "mock imagegen.exe"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;

public static class MockImageGen {
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    private static string Escape(string value) {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void WriteStatus(string path, string command, string state, int exitCode, string output) {
        string saved = state == "success"
            ? "[{\"index\":0,\"absolute_path\":\"" + Escape(output) + "\",\"markdown_path\":\"mock.png\",\"markdown\":\"![mock](mock.png)\",\"revised_prompt\":null}]"
            : "[]";
        string error = state == "failed" ? "{\"message\":\"mock failed\"}" : "null";
        string json = "{\"version\":1,\"status\":\"" + state + "\",\"command\":\"" + Escape(command) + "\",\"exit_code\":" + exitCode + ",\"saved\":" + saved + ",\"timing_ms\":{\"input_prepare\":0,\"api\":1,\"save\":0,\"total\":1},\"error\":" + error + ",\"request_id\":\"mock-request\"}";
        File.WriteAllText(path, json, Utf8);
    }

    public static int Main(string[] args) {
        string statusFile = Environment.GetEnvironmentVariable("NIUCODES_IMAGEGEN_TEST_STATUS_FILE");
        string captureFile = Environment.GetEnvironmentVariable("NIUCODES_IMAGEGEN_TEST_CAPTURE_FILE");
        string historyFile = Environment.GetEnvironmentVariable("NIUCODES_IMAGEGEN_TEST_HISTORY_FILE");
        string outputFile = Environment.GetEnvironmentVariable("NIUCODES_IMAGEGEN_TEST_OUTPUT_FILE");
        string mode = Environment.GetEnvironmentVariable("NIUCODES_IMAGEGEN_TEST_MODE");
        string command = args.Length > 0 ? args[0] : "generate";

        File.WriteAllLines(captureFile, args, Utf8);
        WriteStatus(statusFile, command, "running", 0, null);
        File.WriteAllText(historyFile, "running", Utf8);
        if (mode == "slow") {
            Thread.Sleep(4000);
            return 0;
        }
        Thread.Sleep(150);
        if (mode == "failed") {
            WriteStatus(statusFile, command, "failed", 7, null);
            return 7;
        }
        WriteStatus(statusFile, command, "success", 0, outputFile);
        File.AppendAllText(historyFile, ",success", Utf8);
        return 0;
    }
}
'@ -OutputAssembly $mockExecutable -OutputType ConsoleApplication
$quotedRunnerHelper = Join-Path $tempRoot "invoke quoted runner.ps1"
@'
$ErrorActionPreference = "Stop"
& $env:NIUCODES_IMAGEGEN_TEST_RUNNER generate `
    -StatusFile $env:NIUCODES_IMAGEGEN_TEST_STATUS_FILE `
    -TimeoutSeconds ([int]$env:NIUCODES_IMAGEGEN_TEST_TIMEOUT_SECONDS) `
    -ExecutablePath $env:NIUCODES_IMAGEGEN_TEST_EXECUTABLE `
    -Prompt $env:NIUCODES_IMAGEGEN_TEST_PROMPT `
    -Output $env:NIUCODES_IMAGEGEN_TEST_OUTPUT_FILE `
    -Quality low `
    -Size 1024x1024 `
    -Overwrite true
'@ | Set-Content -LiteralPath $quotedRunnerHelper -Encoding UTF8

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Has-ImageOption($Captured, [string]$Name) {
    $values = @($Captured)
    return (($values -contains "--$Name") -or ($values -contains "-$Name"))
}

function Get-ImageOptionValue($Captured, [string]$Name) {
    $values = @($Captured)
    $index = [Array]::IndexOf($values, "--$Name")
    if ($index -lt 0 -or $index -ge ($values.Count - 1)) { return $null }
    return $values[$index + 1]
}

function Invoke-RunnerCase([string]$Mode, [int]$TimeoutSeconds = 5, [bool]$UseSingleDashAliases = $false, [bool]$UseQuotedPrompt = $false) {
    $caseRoot = Join-Path $tempRoot ("case with spaces " + $Mode)
    [System.IO.Directory]::CreateDirectory($caseRoot) | Out-Null
    $statusFile = Join-Path $caseRoot "final status.json"
    $stdoutFile = Join-Path $caseRoot "runner stdout.json"
    $stderrFile = Join-Path $caseRoot "runner stderr.log"
    $captureFile = Join-Path $caseRoot "captured args.json"
    $historyFile = Join-Path $caseRoot "status history.txt"
    $outputFile = Join-Path $caseRoot "output image.png"
    $prompt = if ($UseQuotedPrompt) { '中文 prompt with spaces and "quoted text"' } else { "中文 prompt with spaces" }
    $promptFlag = if ($UseSingleDashAliases) { "-Prompt" } else { "--prompt" }
    $outputFlag = if ($UseSingleDashAliases) { "-Output" } else { "--output" }
    $qualityFlag = if ($UseSingleDashAliases) { "-Quality" } else { "--quality" }
    $sizeFlag = if ($UseSingleDashAliases) { "-Size" } else { "--size" }
    $overwriteFlag = if ($UseSingleDashAliases) { "-Overwrite" } else { "--overwrite" }
    $runnerArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runner,
        "generate", "--status-file", $statusFile, "--timeout-seconds", $TimeoutSeconds,
        "-ExecutablePath", $mockExecutable,
        $promptFlag, $prompt,
        $outputFlag, $outputFile, $qualityFlag, "low", $sizeFlag, "1024x1024", $overwriteFlag, "true"
    )
    $testEnvironment = @{
        "NIUCODES_IMAGEGEN_TEST_STATUS_FILE" = $statusFile
        "NIUCODES_IMAGEGEN_TEST_CAPTURE_FILE" = $captureFile
        "NIUCODES_IMAGEGEN_TEST_HISTORY_FILE" = $historyFile
        "NIUCODES_IMAGEGEN_TEST_OUTPUT_FILE" = $outputFile
        "NIUCODES_IMAGEGEN_TEST_MODE" = $Mode
        "NIUCODES_IMAGEGEN_TEST_RUNNER" = $runner
        "NIUCODES_IMAGEGEN_TEST_TIMEOUT_SECONDS" = [string]$TimeoutSeconds
        "NIUCODES_IMAGEGEN_TEST_EXECUTABLE" = $mockExecutable
        "NIUCODES_IMAGEGEN_TEST_PROMPT" = $prompt
    }
    $previousEnvironment = @{}
    foreach ($entry in $testEnvironment.GetEnumerator()) {
        $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
    try {
        if ($UseQuotedPrompt) {
            & $hostExe -NoProfile -ExecutionPolicy Bypass -File $quotedRunnerHelper 1> $stdoutFile 2> $stderrFile
        } else {
            & $hostExe @runnerArguments 1> $stdoutFile 2> $stderrFile
        }
        $exitCode = $LASTEXITCODE
    } finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }
    return [ordered]@{
        exit_code = $exitCode
        result = Get-Content -LiteralPath $stdoutFile -Raw -Encoding UTF8 | ConvertFrom-Json
        status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        captured = @(Get-Content -LiteralPath $captureFile -Encoding UTF8)
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
    Assert-True ((Get-ImageOptionValue $success.captured "overwrite") -eq "true") "overwrite value was not preserved"
    Assert-True ((Get-ImageOptionValue $success.captured "output") -eq $success.status.saved[0].absolute_path) "output value was not preserved"
    Assert-True (-not ((Get-ImageOptionValue $success.captured "config") -eq "true")) "overwrite value was misbound as config"

    $quoted = Invoke-RunnerCase "success" 5 $false $true
    Assert-True (($quoted.captured -join "|") -match '中文 prompt with spaces and "quoted text"') "quoted argument was not preserved"

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
