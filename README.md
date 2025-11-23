# Voice Transcription - Raycast Extension

A Raycast extension for Windows that records microphone audio and transcribes it locally using Whisper running on CUDA GPU.

## Features

- 🎤 Record audio from your microphone
- 🚀 Local transcription with Whisper (CUDA-accelerated)
- 📋 Copy transcription to clipboard
- ⌨️ Paste transcription directly at cursor
- 🔄 Auto-start Python transcription server
- 🌍 Multi-language support (auto-detect)

## Prerequisites

### Required Software

1. **UV** - Python package manager
   ```bash
   # Install UV (PowerShell)
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

2. **Bun** - JavaScript runtime (already installed if you're using this extension)

3. **SoX** - Audio recording tool for Windows
   ```bash
   # Install via Chocolatey
   choco install sox.portable
   
   # Or download from: https://sourceforge.net/projects/sox/
   ```

4. **CUD A** - NVIDIA GPU support
   - Install CUDA Toolkit from: https://developer.nvidia.com/cuda-downloads
   - Ensure you have a CUDA-capable NVIDIA GPU

## Installation

### 1. Install Dependencies

#### TypeScript/Node dependencies:
```bash
cd c:\Users\raikr\Documents\projs\raycast-extensions\voice
bun install
```

#### Python dependencies:
```bash
cd backend
uv sync
```

This will install:
- `faster-whisper` - Optimized Whisper implementation with CUDA support
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `python-multipart` - File upload support

### 2. Download Whisper Model (optional)

The model will be downloaded automatically on first use. To pre-download:

```bash
cd backend
uv run python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cuda')"
```

Available models: `tiny`, `base`, `small`, `medium`, `large`

Default is `base` (good balance of speed and accuracy).

## Usage

### Method 1: Via Raycast

1. Open Raycast and search for "transcribe"
2. Click "Start Recording"
3. Speak into your microphone
4. Click "Stop Recording"
5. Wait for transcription to complete
6. Choose to either:
   - **Copy to Clipboard** - Copy the text
   - **Paste at Cursor** - Paste directly where your cursor is

### Method 2: Manual Server Start (optional)

You can manually start the server before using the extension:

```bash
cd backend
start-server.bat
```

Or use UV directly:
```bash
cd backend
uv run python transcription_server.py
```

The server will run on `http://127.0.0.1:5678`

## Configuration

### Change Whisper Model

Set the `WHISPER_MODEL` environment variable before starting:

```bash
# PowerShell
$env:WHISPER_MODEL="small"
cd backend
uv run python transcription_server.py
```

Models (in order of size/accuracy):
- `tiny` - ~1GB VRAM, fastest
- `base` - ~1GB VRAM, good balance ⭐ (default)
- `small` - ~2GB VRAM, better accuracy
- `medium` - ~5GB VRAM, high accuracy
- `large` - ~10GB VRAM, best accuracy

### Audio Recording Settings

Edit `src/audio-recorder.ts` to customize:
- Sample rate (default: 16000 Hz)
- Channels (default: 1 - mono)
- Threshold for silence detection

## Troubleshooting

### "Failed to start recording"

**Issue**: SoX is not installed or not in PATH

**Solution**:
1. Install SoX: `choco install sox.portable`
2. Verify installation: `sox --version`
3. Restart your terminal/Raycast

### "Server failed to start"

**Issue**: CUDA not available or Python dependencies not installed

**Solution**:
1. Verify CUDA is installed: `nvidia-smi`
2. Install Python dependencies: `cd backend && uv sync`
3. Check server logs in the console

### "Model not loaded"

**Issue**: Whisper model failed to download or load

**Solution**:
1. Manually download the model (see Installation step 2)
2. Check internet connection
3. Ensure sufficient disk space (~1-10GB depending on model)

### "Transcription failed"

**Issue**: Audio file is corrupted or server error

**Solution**:
1. Check that the recording completed successfully
2. Try recording again
3. Check server logs for detailed error messages

## Architecture

```
┌─────────────────┐
│  Raycast UI     │
│  (transcribe    │
│   .tsx)         │
└────────┬────────┘
         │
         ├─► AudioRecorder ──► SoX ──► WAV file
         │   (audio-recorder.ts)
         │
         ├─► ServerManager ──► Start/Check Python server
         │   (server-manager.ts)
         │
         └─► TranscriptionClient ──► HTTP POST ──┐
             (transcription-client.ts)            │
                                                  ▼
                                         ┌────────────────┐
                                         │ Python Backend │
                                         │ (FastAPI)      │
                                         └────────┬───────┘
                                                  │
                                                  ▼
                                         ┌────────────────┐
                                         │ faster-whisper │
                                         │ (CUDA)         │
                                         └────────────────┘
```

## Development

### Build the extension

```bash
bun run build
```

### Run in dev mode

```bash
bun run dev
```

### Lint

```bash
bun run lint
```

## License

MIT
