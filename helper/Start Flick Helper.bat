@echo off
title Flick Helper
cd /d "%~dp0"
if not exist node_modules ( echo Installing... & call npm install --silent )
node helper.js
pause
