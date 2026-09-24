@echo off
rem Opens the WebClass assignment UI in the default browser (npm run task:ui).
cd /d "%~dp0"
call npm run task:ui
if errorlevel 1 pause
