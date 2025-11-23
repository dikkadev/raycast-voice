# Quick Start Guide

## ✅ What's New

### Fixed Issues
1. **Backend path resolved** - Now correctly finds the `backend` directory relative to extension
2. **Auto-start recording** - Extension automatically starts recording when opened (no button click needed)

### How It Works Now

When you open the transcribe command:
1. ✓ Checks if server is running
2. ✓ Auto-starts server if needed (first time: ~30-60 seconds to download model)
3. ✓ Automatically begins recording your voice
4. ✓ Stop recording when done → transcription happens
5. ✓ Copy or paste the result

## 🚀 Usage

```bash
# Open Raycast and type "transcribe"
# OR use keyboard shortcut if configured

# Extension will:
# 1. Check server (or start it)
# 2. Start recording immediately
# 3. Show "🔴 Recording..." status

# When done speaking:
# - Press cmd+enter or click "Stop Recording"
# - Wait for transcription
# - Choose "Copy to Clipboard" or "Paste at Cursor"
```

## 📋 Prerequisites Still Needed

Before first use, install SoX for audio recording:

```bash
# Option 1: Chocolatey (recommended)
choco install sox.portable

# Option 2: Download manually
# https://sourceforge.net/projects/sox/
```

Verify:
```bash
sox --version
```

## 🔧 Testing

The extension builds successfully and is ready to use:
```bash
# Build completed ✓
bun run build
```

## 💡 Tips

- **First run**: Server will download the Whisper model (~100MB for base model) - this only happens once
- **Recording quality**: Speak clearly, reduce background noise for best results  
- **Model size**: Default is `base` (fast, accurate). Change via `$env:WHISPER_MODEL="small"` for better accuracy
- **Server stays running**: After first start, server keeps running in background for faster subsequent uses

## 🐛 If Something Goes Wrong

**"Command failed with ENOENT"** - This should be fixed now! Backend path uses `__dirname`

**"Failed to start recording"** - Install SoX (see Prerequisites above)

**"Server failed to start"** - Check:
1. UV is installed: `uv --version`
2. CUDA is available: `nvidia-smi`
3. Backend dependencies installed: `cd backend && uv sync`

See full README for detailed troubleshooting.
