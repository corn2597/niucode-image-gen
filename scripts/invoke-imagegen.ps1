[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("generate", "edit")]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [Alias("status-file")]
    [string]$StatusFile,

    [Alias("timeout-seconds")]
    [ValidateRange(1, 600)]
    # Keep the local wait bound at the supported maximum so it never truncates the configured API deadline.
    [int]$TimeoutSeconds = 600,

    # Test-only override. Production calls locate the bundled executable from this script.
    [string]$ExecutablePath,

    [string]$Prompt,
    [string]$Output,
    [string[]]$Image,
    [string]$Mask,
    [string]$Quality,
    [string]$Size,
    [string]$Model,
    [string]$Config,
    [Alias("base-url")]
    [string]$BaseUrl,
    [Alias("output-format")]
    [string]$OutputFormat,
    [string]$Background,
    [string]$Moderation,
    [string]$N,
    [string]$Overwrite,
    [Alias("timeout-ms")]
    [string]$TimeoutMs,
    [Alias("verbose-response")]
    [string]$VerboseResponse,
    [Alias("input-fidelity")]
    [string]$InputFidelity,
    [Alias("output-compression")]
    [string]$OutputCompression,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ImageArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Write-Stderr([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

function ConvertTo-WindowsCommandLine([string[]]$Arguments) {
    return (($Arguments | ForEach-Object {
        if ($_ -notmatch '[\s"]') { return $_ }
        '"' + ($_ -replace '(\\*)"', '$1$1\\"' -replace '(\\*)$', '$1$1') + '"'
    }) -join ' ')
}

function Read-StatusFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Write-AtomicJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
    $temporary = "$Path.$PID.$([DateTime]::UtcNow.Ticks).tmp"
    $json = $Value | ConvertTo-Json -Compress -Depth 12
    [System.IO.File]::WriteAllText($temporary, "$json`n", (New-Object System.Text.UTF8Encoding($false)))
    if (-not ("NiuCodesImageGen.NativeFile" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace NiuCodesImageGen {
    public static class NativeFile {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
    }
}
'@
    }
    # MOVEFILE_REPLACE_EXISTING (1) | MOVEFILE_WRITE_THROUGH (8). Both paths share a directory.
    if (-not [NiuCodesImageGen.NativeFile]::MoveFileEx($temporary, $Path, 9)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-Object ComponentModel.Win32Exception($errorCode, "Unable to publish status file"))
    }
}

function New-FailureResult([string]$FailureCommand, [int]$ExitCode, [string]$Message, $Timing) {
    return [ordered]@{
        version = 1
        status = "failed"
        command = $FailureCommand
        exit_code = $ExitCode
        saved = @()
        timing_ms = $Timing
        error = [ordered]@{ message = $Message }
        request_id = $null
    }
}

function Normalize-ImageArguments([string[]]$Arguments) {
    # Accept common PowerShell spellings while preserving the native CLI contract.
    $aliases = @{
        "-prompt" = "--prompt"
        "-output" = "--output"
        "-image" = "--image"
        "-mask" = "--mask"
        "-quality" = "--quality"
        "-size" = "--size"
        "-model" = "--model"
        "-config" = "--config"
        "-baseurl" = "--base-url"
        "-base-url" = "--base-url"
        "-outputformat" = "--output-format"
        "-output-format" = "--output-format"
        "-background" = "--background"
        "-moderation" = "--moderation"
        "-n" = "--n"
        "-overwrite" = "--overwrite"
        "-timeoutms" = "--timeout-ms"
        "-timeout-ms" = "--timeout-ms"
        "-verboseresponse" = "--verbose-response"
        "-verbose-response" = "--verbose-response"
        "-inputfidelity" = "--input-fidelity"
        "-input-fidelity" = "--input-fidelity"
        "-outputcompression" = "--output-compression"
        "-output-compression" = "--output-compression"
    }

    return @($Arguments | ForEach-Object {
        $alias = $aliases[$_.ToLowerInvariant()]
        if ($alias) { $alias } else { $_ }
    })
}

function Add-ImageOption([System.Collections.Generic.List[string]]$Destination, [string]$Name, $Value) {
    if ($null -eq $Value) { return }
    foreach ($item in @($Value)) {
        if ($null -eq $item) { continue }
        $Destination.Add("--$Name")
        $Destination.Add([string]$item)
    }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExecutablePath) {
    $ExecutablePath = Join-Path $skillRoot "bin\niucodes-image-gen-win-x64.exe"
}
$StatusFile = [System.IO.Path]::GetFullPath($StatusFile)
if ($ImageArguments -contains "--status-file") {
    throw "Pass -StatusFile to invoke-imagegen.ps1; do not pass --status-file to the executable arguments."
}
$normalizedImageArguments = New-Object 'System.Collections.Generic.List[string]'
Add-ImageOption $normalizedImageArguments "prompt" $Prompt
Add-ImageOption $normalizedImageArguments "output" $Output
Add-ImageOption $normalizedImageArguments "image" $Image
Add-ImageOption $normalizedImageArguments "mask" $Mask
Add-ImageOption $normalizedImageArguments "quality" $Quality
Add-ImageOption $normalizedImageArguments "size" $Size
Add-ImageOption $normalizedImageArguments "model" $Model
Add-ImageOption $normalizedImageArguments "config" $Config
Add-ImageOption $normalizedImageArguments "base-url" $BaseUrl
Add-ImageOption $normalizedImageArguments "output-format" $OutputFormat
Add-ImageOption $normalizedImageArguments "background" $Background
Add-ImageOption $normalizedImageArguments "moderation" $Moderation
Add-ImageOption $normalizedImageArguments "n" $N
Add-ImageOption $normalizedImageArguments "overwrite" $Overwrite
Add-ImageOption $normalizedImageArguments "timeout-ms" $TimeoutMs
Add-ImageOption $normalizedImageArguments "verbose-response" $VerboseResponse
Add-ImageOption $normalizedImageArguments "input-fidelity" $InputFidelity
Add-ImageOption $normalizedImageArguments "output-compression" $OutputCompression
$normalizedImageArguments.AddRange([string[]](Normalize-ImageArguments $ImageArguments))
$arguments = @($Command) + @($normalizedImageArguments) + @("--status-file", $StatusFile)
$startedAt = [DateTime]::UtcNow
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$process = $null
$finalResult = $null

try {
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "Bundled executable was not found: $ExecutablePath"
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $ExecutablePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($startInfo.PSObject.Properties.Name -contains "ArgumentList") {
        foreach ($argument in $arguments) { [void]$startInfo.ArgumentList.Add($argument) }
    } else {
        $startInfo.Arguments = ConvertTo-WindowsCommandLine $arguments
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Unable to start bundled executable." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

    do {
        $candidate = Read-StatusFile $StatusFile
        if ($candidate -and $candidate.status -in @("success", "failed")) {
            $finalResult = $candidate
        }
        if ($process.HasExited -or $finalResult -or [DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 1
    } while ($true)

    if ([DateTime]::UtcNow -ge $deadline -and -not $process.HasExited -and -not $finalResult) {
        $process.Kill()
        $process.WaitForExit()
        $finalResult = New-FailureResult $Command 124 "Timed out after $TimeoutSeconds seconds." @{ total = [int][Math]::Round($stopwatch.Elapsed.TotalMilliseconds) }
        Write-AtomicJson $StatusFile $finalResult
    } elseif (-not $process.HasExited) {
        $process.WaitForExit()
    }

    $childExitCode = $process.ExitCode
    $childStderr = $stderrTask.GetAwaiter().GetResult()
    [void]$stdoutTask.GetAwaiter().GetResult()
    if ($childStderr) { Write-Stderr $childStderr.TrimEnd() }

    if (-not $finalResult) {
        $finalResult = Read-StatusFile $StatusFile
    }
    if (-not $finalResult -or $finalResult.status -notin @("success", "failed")) {
        $finalResult = New-FailureResult $Command $childExitCode "Executable exited without a final status result." @{ total = [int][Math]::Round($stopwatch.Elapsed.TotalMilliseconds) }
        Write-AtomicJson $StatusFile $finalResult
    }

    $finalResult.exit_code = $childExitCode
    if ($finalResult.status -eq "success" -and $childExitCode -ne 0) {
        $finalResult = New-FailureResult $Command $childExitCode "Executable returned a nonzero exit code after success status." $finalResult.timing_ms
    }
    Write-AtomicJson $StatusFile $finalResult
} catch {
    $finalResult = New-FailureResult $Command 1 $_.Exception.Message @{ total = [int][Math]::Round($stopwatch.Elapsed.TotalMilliseconds) }
    try { Write-AtomicJson $StatusFile $finalResult } catch { Write-Stderr $_.Exception.Message }
}

[Console]::Out.WriteLine(($finalResult | ConvertTo-Json -Compress -Depth 12))
exit [int]$finalResult.exit_code
