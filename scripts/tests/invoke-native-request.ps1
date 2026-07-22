[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [Parameter(Mandatory = $true)]
  [string]$RequestFile
)

$ErrorActionPreference = "Stop"

# Deliberately pass only the fixed native request-file protocol arguments.
& $Executable "run" "--request-file" $RequestFile
exit $LASTEXITCODE
