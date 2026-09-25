@echo off
cd /d "%~dp0"
chcp 65001 >nul
title MemoryWeaver - Cai dat he thong tu dong
echo ======================================================================
echo    MEMORYWEAVER - CAI DAT HE THONG TU DONG (SERVER + EXPO APP)
echo ======================================================================
echo.

:: 1. Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] May chua cai dat Node.js!
    echo Vui long tai va cai dat Node.js tu: https://nodejs.org/ (Phien ban 22 tro len)
    pause
    exit /b 1
)
echo [OK] Node.js da duoc tim thay:
node -v
echo.

:: 2. Cau hinh khoa va token bang script, khong tao khoa mau.
if not exist "server\.env" (
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\server\configure-gemini.ps1"
    if errorlevel 1 exit /b 1
)

:: 3. Cai dat thu vien cho Backend Server
echo ----------------------------------------------------------------------
echo [1/2] Dang cai dat thu vien cho Backend Server (Node.js)...
echo ----------------------------------------------------------------------
cd server
call npm install
if %errorlevel% neq 0 (
    echo [LOI] Khong the cai dat thu vien server!
    cd ..
    pause
    exit /b 1
)
cd ..
echo [OK] Backend Server da cai dat xong!
echo.

:: 4. Cai dat thu vien cho Frontend Expo App
echo ----------------------------------------------------------------------
echo [2/2] Dang cai dat thu vien cho Mobile App (Expo / React Native)...
echo ----------------------------------------------------------------------
cd expo-app
call npm install
if %errorlevel% neq 0 (
    echo [LOI] Khong the cai dat thu vien expo-app!
    cd ..
    pause
    exit /b 1
)

:: Build viewer HTML offline
call node scripts/build-viewer.cjs
if errorlevel 1 (
    cd ..
    echo [LOI] Khong dong goi duoc bo hien thi 3D.
    exit /b 1
)
cd ..
echo [OK] Mobile App da cai dat xong!
echo.

echo ======================================================================
echo    DA CAI THU VIEN VA DONG GOI BO HIEN THI
echo ======================================================================
echo  1. Mo file 'server\.env' kiem tra GEMINI_API_KEY.
echo  2. Click dup vao file 'CHAY_HE_THONG.bat' de khoi dong ca Server va App.
echo ======================================================================
echo.
pause
