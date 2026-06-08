@echo off
setlocal

set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3092" ^| findstr "LISTENING"') do (
    set "FOUND=1"
    echo [Stop] Killing PID %%a on port 3092 ...
    taskkill /PID %%a /F >nul 2>&1
    if errorlevel 1 (
        echo [Stop] Failed to kill PID %%a
    ) else (
        echo [Stop] PID %%a killed
    )
)

if "%FOUND%"=="0" (
    echo [Stop] No service running on port 3092
)

endlocal
pause
