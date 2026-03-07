Write-Host "Starting AI Starship Odyssey..." -ForegroundColor Cyan

# 1. Start Rust Engine (Core State & Game Loop)
Write-Host "Starting Rust Core Engine..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit -Command `"cd engines/core-state; cargo run --release`""

# 2. Start Python AI Director
Write-Host "Starting Python AI Director..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit -Command `"cd apps/python-director; .\venv\Scripts\activate; uvicorn main:app --port 8000`""

# 3. Start React Web Client
Write-Host "Starting React Web Client..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit -Command `"cd apps/web-client; npm run dev`""

Write-Host "All processes have been launched in separate windows!" -ForegroundColor Green
Write-Host "Use stop_all.ps1 to cleanly kill them." -ForegroundColor Gray
