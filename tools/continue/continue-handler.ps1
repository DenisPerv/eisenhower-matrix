# Continue in Claude: the handler of homeos-claude:// links. Windows runs it with the link as one argument (install-continue-handler.ps1).
# The link is matched whole against one strict pattern, so only a UUID and a task reference go on, as separate arguments and never through a shell
# string. -Check runs no Claude session and does not wait for a key, for tests. Otherwise the window stays open so the person can read the result.
param(
  [Parameter(Position = 0)][string]$Uri = '',
  [string]$ProjectDir = '',
  [string]$EnvFile = '',
  [string]$As = '',
  [switch]$Check
)

$pattern = '^homeos-claude://continue/?\?sid=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})&ref=([a-z0-9_-]{1,64})%23([0-9]{1,7})/?$'
$code = 2

if ($Uri -cnotmatch $pattern) {
  Write-Output 'Refused: this link is not a session id and a task reference. Nothing was run.'
} else {
  $sid = $Matches[1]
  $ref = $Matches[2] + '#' + $Matches[3]
  $script = Join-Path $PSScriptRoot 'continue-handler.mjs'
  $nodeArgs = @($script, '--sid', $sid, '--ref', $ref, '--project', $ProjectDir)
  if ($EnvFile) { $nodeArgs += @('--env', $EnvFile) }
  if ($As) { $nodeArgs += @('--as', $As) }
  if ($Check) { $nodeArgs += '--check' }
  & node @nodeArgs
  $code = $LASTEXITCODE
}

if (-not $Check) {
  Write-Output ''
  Write-Output 'You can close this window.'
  [void][System.Console]::ReadKey($true)
}
exit $code
