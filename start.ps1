# Starts the whole project and makes sure the MySQL InnoDB Cluster is online.
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File .\start.ps1

# "Continue": Windows PowerShell 5.1 treats docker's normal stderr output as an error under "Stop"
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "1/3 Starting containers..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

Write-Host "`n2/3 Waiting for mysql-1 to accept connections..." -ForegroundColor Cyan
for ($i = 0; $i -lt 60; $i++) {
    docker exec mysql-1 sh -c 'mysqladmin -uroot -p$MYSQL_ROOT_PASSWORD ping' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 3
}

Write-Host "`n3/3 Bringing the InnoDB Cluster online..." -ForegroundColor Cyan
# The script is piped in on stdin; the password comes from the container's own environment
Get-Content .\mysql-cluster\start-cluster.js -Raw |
    docker exec -i mysql-1 sh -c 'LC_ALL=C mysqlsh --no-wizard --js --uri root@mysql-1:3306 --password=$MYSQL_ROOT_PASSWORD 2>&1'

Write-Host "`nChecking the backend..." -ForegroundColor Cyan
for ($i = 0; $i -lt 30; $i++) {
    try {
        $health = Invoke-RestMethod -Uri http://localhost:3000/api/health -TimeoutSec 5
        if ($health.status -eq "UP") { break }
    } catch { }
    Start-Sleep -Seconds 3
}

if ($health.status -eq "UP") {
    Write-Host "`nEverything is up. Website: http://localhost:8080" -ForegroundColor Green
} else {
    Write-Host "`nBackend is not healthy yet. Check: docker logs devops-backend / docker logs mysql-router" -ForegroundColor Yellow
}
