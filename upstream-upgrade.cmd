@echo off
setlocal
cd /d "%~dp0"
npm run upgrade:upstream -- --install --verify
echo.
pause
