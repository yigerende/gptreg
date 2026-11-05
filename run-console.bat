@echo off
title GPT-Register Console
cd /d "%~dp0"
echo ========================================================
echo               GPT-Register 控制台启动中
echo ========================================================
echo.
echo 本地服务端口: 3210
echo 访问地址: http://127.0.0.1:3210
echo (提示: 前台运行模式下，直接按 Ctrl + C 即可停止服务)
echo.
node src\ui-server\index.js
pause
