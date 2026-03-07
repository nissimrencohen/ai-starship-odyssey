# Stop all project components by killing processes on their respective ports

$ports = @(8000, 5173, 8080, 8081)

foreach ($port in $ports) {
    Write-Host "Checking port $port..." -ForegroundColor Cyan
    $process = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1
    
    if ($process) {
        $procDetails = Get-Process -Id $process -ErrorAction SilentlyContinue
        if ($procDetails) {
            Write-Host "Killing process $($procDetails.Name) (PID: $process) on port $port" -ForegroundColor Yellow
            Stop-Process -Id $process -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        Write-Host "No process found on port $port" -ForegroundColor Gray
    }
}

# Also cleanup common process names just in case
$extraProcesses = @("uvicorn", "core-state")
foreach ($name in $extraProcesses) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Found extra process: $name. Killing..." -ForegroundColor Yellow
        Stop-Process -Name $name -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Shutdown sequence complete." -ForegroundColor Green
