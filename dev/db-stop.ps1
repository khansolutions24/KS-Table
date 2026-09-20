# Stops the portable MySQL test server gracefully.
. (Join-Path $PSScriptRoot 'db-common.ps1')

if (-not (Test-DbReady $RootPassword)) { Write-Output 'MySQL is not running'; return }
& $MySqlAdmin -uroot "-p$RootPassword" '-h127.0.0.1' "-P$Port" shutdown 2>&1 | Where-Object { $_ -notmatch 'Using a password' }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process mysqld -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Base*" })) { Write-Output 'MySQL stopped'; return }
  Start-Sleep -Milliseconds 500
}
Write-Output 'MySQL is still shutting down'
