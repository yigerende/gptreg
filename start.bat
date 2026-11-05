@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-gpt-re.ps1" %*
exit /b %ERRORLEVEL%
