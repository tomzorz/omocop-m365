# Thin wrapper: the installer logic lives once, in install-skills.mjs.
param(
  [switch]$Force,
  [string]$Config
)

$scriptArgs = @()
if ($Force) { $scriptArgs += '--force' }
if ($Config) { $scriptArgs += @('--config', $Config) }

& node (Join-Path $PSScriptRoot 'install-skills.mjs') @scriptArgs
exit $LASTEXITCODE
