# Shared settings for the portable MySQL test server (never installed as a service, never autostarted).
# Note: Windows PowerShell 5.1 turns native stderr output into errors, so no 'Stop' preference here.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$DevDb = Join-Path $Root '.devdb'
$MySqlVersion = '8.4.11'
$Base = Join-Path $DevDb "mysql-$MySqlVersion-winx64"
$DataDir = Join-Path $DevDb 'data'
$Ini = Join-Path $DevDb 'my.ini'
$Port = 3307
$RootPassword = 'kstable'
$MySqld = Join-Path $Base 'bin\mysqld.exe'
$MySql = Join-Path $Base 'bin\mysql.exe'
$MySqlAdmin = Join-Path $Base 'bin\mysqladmin.exe'

function Test-DbReady([string]$password) {
  $cmdArgs = @('-uroot', '-h127.0.0.1', "-P$Port", '--connect-timeout=2', 'ping')
  if ($password) { $cmdArgs = @("-p$password") + $cmdArgs }
  $null = & $MySqlAdmin @cmdArgs 2>&1
  return ($LASTEXITCODE -eq 0)
}
