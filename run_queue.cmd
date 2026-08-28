@echo off
REM Fired hourly by Windows Task Scheduler. Uploads at most one due item
REM from queue.json, then appends the result to queue.log.
cd /d "%~dp0"
echo. >> queue.log
echo ===== %DATE% %TIME% ===== >> queue.log
node queue.js --confirm >> queue.log 2>&1
