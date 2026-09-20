# Starts the portable MySQL test server as a normal background process (no service, no autostart).
param([switch]$NoPasswordFirst)
. (Join-Path $PSScriptRoot 'db-common.ps1')

$pw = if ($NoPasswordFirst) { '' } else { $RootPassword }
if (Test-DbReady $pw) { Write-Output "MySQL already running on port $Port"; return }

Start-Process -FilePath $MySqld -ArgumentList "--defaults-file=`"$Ini`"" -WindowStyle Hidden | Out-Null
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (Test-DbReady $pw) { Write-Output "MySQL ready on 127.0.0.1:$Port"; return }
  Start-Sleep -Milliseconds 700
}
Get-Content (Join-Path $DevDb 'mysqld.err') -Tail 30
throw 'MySQL did not start'
