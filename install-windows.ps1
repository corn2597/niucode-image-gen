# Install the newest Gitee release package into Codex. Run from PowerShell.
$ErrorActionPreference = 'Stop'

$repository = 'niucodes/niucode-image-gen'
$releaseApiUrl = if ($env:NIUCODES_IMAGE_GEN_RELEASE_API_URL) {
  $env:NIUCODES_IMAGE_GEN_RELEASE_API_URL
} else {
  "https://gitee.com/api/v5/repos/$repository/releases/latest"
}
$skillName = 'niucodes-image-gen'
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillDir = Join-Path (Join-Path $codexRoot 'skills') $skillName
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("niucodes-image-gen-" + [guid]::NewGuid().ToString('N'))

function Stop-Install([string] $Message) {
  throw "Installation failed: $Message"
}

try {
  if (-not [Environment]::Is64BitOperatingSystem) {
    Stop-Install 'Only 64-bit Windows is supported.'
  }

  $apiKeyPrompt = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('6K+36L6T5YWlIG5pdWNvZGVz55qEYXBpIGtlee+8jGFwaSBrZXnmn6Xmib7lnLDlnYDvvJogd29ya3NwYWNlLmNsYXVkZWNvZGVzLm9yZ++8jCDngrnlh7vlt6bkvqdBUEnlr4bpkqXlpI3liLbvvJo='))
  $secureApiKey = Read-Host $apiKeyPrompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiKey)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Stop-Install 'An API key is required.'
  }

  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $release = Invoke-RestMethod -Uri $releaseApiUrl -Headers @{ Accept = 'application/json' }
  if ([string]::IsNullOrWhiteSpace($release.tag_name)) {
    Stop-Install 'The Gitee release metadata does not contain tag_name.'
  }

  $platform = 'win-x64'
  $binaryName = 'niucodes-image-gen-win-x64.exe'
  $archiveName = "$skillName-$platform-$($release.tag_name).zip"
  $archiveAsset = @($release.assets | Where-Object { $_.name -eq $archiveName }) | Select-Object -First 1
  $checksumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
  if ($null -eq $archiveAsset) { Stop-Install "The latest Gitee release does not include $archiveName." }
  if ($null -eq $checksumAsset) { Stop-Install 'The latest Gitee release does not include SHA256SUMS.txt.' }

  $archiveUrl = if ($archiveAsset.browser_download_url) { $archiveAsset.browser_download_url } else { $archiveAsset.download_url }
  $checksumUrl = if ($checksumAsset.browser_download_url) { $checksumAsset.browser_download_url } else { $checksumAsset.download_url }
  if ([string]::IsNullOrWhiteSpace($archiveUrl) -or [string]::IsNullOrWhiteSpace($checksumUrl)) {
    Stop-Install 'The Gitee release does not contain usable asset download URLs.'
  }

  $archivePath = Join-Path $tempDir $archiveName
  $checksumPath = Join-Path $tempDir 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
  Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath
  $checksumLine = Get-Content -LiteralPath $checksumPath | Where-Object {
    $_ -match "^([0-9a-fA-F]{64})\s+\*?$archiveName$"
  } | Select-Object -First 1
  if ($null -eq $checksumLine) { Stop-Install "SHA256SUMS.txt has no checksum for $archiveName." }
  $expectedHash = (($checksumLine -split '\s+')[0]).ToUpperInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) { Stop-Install "SHA-256 verification failed for $archiveName." }

  $unpackDir = Join-Path $tempDir 'unpacked'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $unpackDir -Force
  $packageDir = Join-Path $unpackDir "$skillName-$platform"
  $executable = Join-Path (Join-Path $packageDir 'bin') $binaryName
  if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'config.json') -PathType Leaf)) {
    Stop-Install 'Release package has an unexpected layout.'
  }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    Stop-Install "Release package is missing $binaryName."
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $codexRoot 'skills') | Out-Null
  & $executable install --install-dir $skillDir --config-path (Join-Path $codexRoot 'config.toml') | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'Could not install the native skill package.' }

  $configPath = Join-Path $skillDir 'config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { Stop-Install 'Installed config.json was not found.' }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($null -eq $config.PSObject.Properties['apiKey']) {
    $config | Add-Member -NotePropertyName apiKey -NotePropertyValue $apiKey
  } else {
    $config.apiKey = $apiKey
  }
  $temporaryConfigPath = Join-Path $tempDir 'config.json'
  $configJson = $config | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temporaryConfigPath, $configJson, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryConfigPath -Destination $configPath -Force

  $installedExecutable = Join-Path (Join-Path $skillDir 'bin') $binaryName
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { Stop-Install 'Installed executable was not found.' }
  & $installedExecutable --help | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'Installed executable did not start.' }

  Write-Host "Installed $skillName ($($release.tag_name)) to $skillDir"
  Write-Host 'Restart Codex Desktop before using the skill.'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  Remove-Variable -Name apiKey -ErrorAction SilentlyContinue
  Remove-Variable -Name secureApiKey -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
