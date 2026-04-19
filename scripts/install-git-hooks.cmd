@echo off
setlocal

git -C "%~dp0.." config core.hooksPath .githooks
if errorlevel 1 exit /b 1

echo Configured core.hooksPath=.githooks in %~dp0..
exit /b 0