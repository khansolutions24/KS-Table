# Downloads the official MySQL ZIP, initializes a data directory in .devdb and loads dev/sample-db.sql.
# Usage: powershell -ExecutionPolicy Bypass -File dev/db-setup.ps1 [-Reload]
param([switch]$Reload)
. (Join-Path $PSScriptRoot 'db-common.ps1')

New-Item -ItemType Directory -Force $DevDb | Out-Null

if (-not (Test-Path $MySqld)) {
  $zip = Join-Path $DevDb "mysql-$MySqlVersion-winx64.zip"
  if (-not (Test-Path $zip)) {
    Write-Output "Downloading MySQL $MySqlVersion (cdn.mysql.com) ..."
    Invoke-WebRequest -Uri "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-$MySqlVersion-winx64.zip" -OutFile $zip -UseBasicParsing
  }
  Write-Output 'Extracting ...'
  tar -xf $zip -C $DevDb
  if (-not (Test-Path $MySqld)) { throw "mysqld.exe not found after extracting" }
}

$fwd = { param($p) $p -replace '\\', '/' }
@"
[mysqld]
basedir="$(& $fwd $Base)"
datadir="$(& $fwd $DataDir)"
port=$Port
bind-address=127.0.0.1
mysqlx=OFF
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
event_scheduler=ON
max_allowed_packet=256M
log-error="$(& $fwd (Join-Path $DevDb 'mysqld.err'))"
pid-file="$(& $fwd (Join-Path $DevDb 'mysqld.pid'))"

[client]
port=$Port
default-character-set=utf8mb4
"@ | Set-Content -Path $Ini -Encoding ascii

$fresh = $false
if (-not (Test-Path (Join-Path $DataDir 'mysql'))) {
  Write-Output 'Initializing data directory ...'
  & $MySqld "--defaults-file=$Ini" --initialize-insecure --console 2>&1 | Select-Object -Last 3
  $fresh = $true
}

& (Join-Path $PSScriptRoot 'db-start.ps1') -NoPasswordFirst:$fresh

if ($fresh) {
  Write-Output 'Setting root password ...'
  & $MySql -uroot "-h127.0.0.1" "-P$Port" -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '$RootPassword';"
}

if ($fresh -or $Reload) {
  Write-Output 'Loading dev/sample-db.sql ...'
  $sql = Join-Path $Root 'dev\sample-db.sql'
  $err = Join-Path $DevDb 'load.err'
  $p = Start-Process -FilePath $MySql -ArgumentList @('-uroot', "-p$RootPassword", '-h127.0.0.1', "-P$Port", '--default-character-set=utf8mb4') `
    -RedirectStandardInput $sql -RedirectStandardError $err -NoNewWindow -Wait -PassThru
  Get-Content $err | Where-Object { $_ -notmatch 'Using a password' }
  Write-Output "Load exit code: $($p.ExitCode)"
}

& $MySql -uroot "-p$RootPassword" '-h127.0.0.1' "-P$Port" -e "SELECT table_schema, COUNT(*) AS objects, SUM(table_rows) AS approx_rows FROM information_schema.tables WHERE table_schema LIKE 'ks\_%' GROUP BY table_schema; SELECT VERSION();" 2>&1 | Where-Object { $_ -notmatch 'Using a password' }
