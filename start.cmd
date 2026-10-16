@echo off
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo Please run npm.cmd install and npm.cmd run build first.
  pause
  exit /b 1
)
echo PeopleDesk will be available at http://127.0.0.1:8000
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
) else (
  python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
)
pause
