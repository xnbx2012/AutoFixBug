@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3092" ^| findstr "LISTENING"') do (
    echo [Start] Port 3092 is in use, killing PID %%a ...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

if not exist "node_modules" (
    echo [Start] Installing dependencies ...
    call npm install
    if errorlevel 1 (
        echo [Start] npm install failed
        pause
        exit /b 1
    )
)

echo [Start] Launching auto-fix-bug service ...
start /B npm start > logs\start.log 2>&1

for /l %%i in (1,1,30) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3092" ^| findstr "LISTENING"') do (
        echo [Start] Service started: http://localhost:3092
        exit /b 0
    )
    timeout /t 1 /nobreak >nul
)

echo [Start] Timed out waiting for service to start, check logs\start.log
pause
exit /b 1
