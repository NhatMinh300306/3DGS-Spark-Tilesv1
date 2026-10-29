@echo off
cd /d "%~dp0"
py serve.py --bind 127.0.0.1 --port 8765 --directory dist
pause
