# Registers homeos-claude:// for this Windows user, so the Continue in Claude button works. One key under HKCU, nothing else. README in this folder.
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-continue-handler.ps1 -ProjectDir <folder the sessions ran in> [-EnvFile <file>] [-As <handle>]
#   ... -Uninstall   removes the key
#   ... -Show        prints what would be written, and writes nothing
param(
  [string]$ProjectDir = '',
  [string]$EnvFile = '',
  [string]$As = '',
  [switch]$Uninstall,
  [switch]$Show
)

$key = 'HKCU:\Software\Classes\homeos-claude'

if ($Uninstall) {
  if ($Show) { Write-Output "would remove $key"; exit 0 }
  if (Test-Path $key) { Remove-Item -Path $key -Recurse; Write-Output 'Removed homeos-claude://' } else { Write-Output 'homeos-claude:// was not installed' }
  exit 0
}

if (-not $ProjectDir -or -not (Test-Path -LiteralPath $ProjectDir -PathType Container)) {
  Write-Output 'Give -ProjectDir: the folder the agent sessions ran in.'
  exit 2
}

$handler = Join-Path $PSScriptRoot 'continue-handler.ps1'
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $handler + '" -ProjectDir "' + (Resolve-Path -LiteralPath $ProjectDir).Path + '"'
if ($EnvFile) { $command += ' -EnvFile "' + (Resolve-Path -LiteralPath $EnvFile).Path + '"' }
if ($As) { $command += ' -As "' + $As + '"' }
$command += ' "%1"'

if ($Show) {
  Write-Output $key
  Write-Output $command
  exit 0
}

New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path $key -Value 'URL:TasksDashboard Continue in Claude'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path "$key\shell\open\command" -Value $command
Write-Output "Installed homeos-claude:// -> $handler"
