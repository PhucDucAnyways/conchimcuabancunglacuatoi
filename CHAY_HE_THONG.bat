@echo off
cd /d "%~dp0"
chcp 65001 >nul
title MemoryWeaver - Khoi dong he thong
echo ======================================================================
echo    MEMORYWEAVER - KHOI DONG DONG THOI BACKEND + EXPO APP
echo ======================================================================
echo.

if not exist "expo-app\node_modules" (
    echo [CANH BAO] Ban chua cai dat thu vien! Dang tu dong goi CAI_DAT_NHANH.bat...
    call CAI_DAT_NHANH.bat
    if errorlevel 1 exit /b 1
)

if not exist "server\.env" (
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\server\configure-gemini.ps1"
    if errorlevel 1 exit /b 1
)

:: Khong tu dung tien trinh dang chiem cong; npm start se bao loi neu cong ban.
echo [1/2] Dang khoi dong Backend Server (Port 8787)...
start "MemoryWeaver - Backend Server (Port 8787)" cmd /k "cd server && npm start"

timeout /t 2 /nobreak >nul

echo [2/2] Dang khoi dong Expo App Bundler...
start "MemoryWeaver - Expo App" cmd /k "cd expo-app && npm start -- --clear"

echo.
echo ======================================================================
echo    DA MO HAI CUA SO. KIEM TRA LOG SERVER VA QR EXPO.
echo ======================================================================
echo  - Cua so 1: Backend Server dang chay tai: http://localhost:8787
echo  - Cua so 2: Expo Dev Server se hien ma QR de ban quet bang:
echo      + Dien thoai Android: Mo app Expo Go quet ma QR
echo      + Ban hop nhat nay chua co APK moi. APK cu khong chua cac thay doi.
echo ======================================================================
echo.
pause
