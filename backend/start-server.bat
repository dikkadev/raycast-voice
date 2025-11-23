@echo off
REM Start the Whisper transcription server using UV

echo Starting Whisper Transcription Server...
echo Using model: %WHISPER_MODEL% (default: base)
echo.

cd /d "%~dp0"
uv run python transcription_server.py
