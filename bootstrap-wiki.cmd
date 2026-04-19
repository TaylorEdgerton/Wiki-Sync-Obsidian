@echo off
setlocal

set "BASH_EXE="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\usr\bin\bash.exe"
if not defined BASH_EXE if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LocalAppData%\Programs\Git\bin\bash.exe"
if not defined BASH_EXE (
    for /f "delims=" %%B in ('where bash 2^>nul') do (
        if not defined BASH_EXE set "BASH_EXE=%%B"
    )
)

if not defined BASH_EXE (
    echo bash was not found on PATH.
    echo Install Git for Windows or run bootstrap-wiki.sh from a Bash shell.
    exit /b 1
)

if not exist "%~dp0bootstrap-wiki.sh" (
    echo bootstrap-wiki.sh was not found next to bootstrap-wiki.cmd.
    echo Copy bootstrap-wiki.sh into "%~dp0" or run this wrapper from the project folder.
    exit /b 1
)

if not exist "%~dp0bootstrap-profiles\" (
    echo bootstrap-profiles was not found next to bootstrap-wiki.cmd.
    echo Copy the bootstrap-profiles folder into "%~dp0" before running the bootstrap.
    exit /b 1
)

pushd "%~dp0" >nul
if errorlevel 1 (
    echo Failed to enter bootstrap folder "%~dp0".
    exit /b 1
)

"%BASH_EXE%" "./bootstrap-wiki.sh" %*
set "exit_code=%errorlevel%"
popd >nul
exit /b %exit_code%
