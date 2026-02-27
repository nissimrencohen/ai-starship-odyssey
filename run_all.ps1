# Launch all project components in separate windows

# 1. Python Director (Backend)
Write-Host "Starting Python Director..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd apps/python-director; ./venv/Scripts/activate; uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

# 2. Web Client (Frontend)
Write-Host "Starting Web Client..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd apps/web-client; npm run dev"

# 3. Core State (Rust Engine)
Write-Host "Starting Core State (Rust)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd engines/core-state; cargo run"

Write-Host "All components are starting in separate windows." -ForegroundColor Green
