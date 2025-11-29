# Voice Transcription - Raycast Extension (WIP)

**Status**: Work in Progress  
**Platform**: Windows Only  
**Purpose**: Quick-access, high-quality, local-only transcription using Whisper models with CUDA GPU acceleration

---

## 🎯 Core Use Case

A Raycast extension that provides **very quickly accessible**, **very high quality**, **local-only** transcription. When the Raycast command is selected, it should:
1. Auto-start listening (configurable)
2. Stop on Enter press
3. Save temp files and run through the Whisper model
4. Show transcribed text with action options (Copy, Paste)

---

## 🐛 Bugs to Research and Fix

### Known Issues
- [ ] **No download progress** - First model download shows no progress indicator

---

## ✅ Implemented Features

### Core Functionality
- [x] **Auto-start recording** - Configurable via preferences (default: on)
- [x] **Backend recording** - Python backend handles microphone capture using `sounddevice`
- [x] **Whisper transcription** - Uses `faster-whisper` for GPU/CPU transcription
- [x] **Temporary file handling** - Records to temp directory, cleans up after transcription
- [x] **Server management** - Auto-starts Python backend server if not running
- [x] **Health checks** - Server health monitoring and status checks
- [x] **Server restart** - Automatically restarts server when config changes

### User Interface
- [x] **Clean, minimal UI** - Simple state display without clutter
- [x] **Recording states** - Visual feedback for: idle, checking, starting, recording, processing, done, error
- [x] **Config display** - Shows current model and device
- [x] **Action panel** - Context-aware actions based on current state
- [x] **Recording timer** - Elapsed time indicator while capturing audio
- [x] **Audio level indicator** - Basic implementation (needs UI improvements)
- [x] **Full UI redesign** - Complete UI overhaul with modern, polished design including improved audio level indicator with smooth animations, better visual hierarchy and spacing, enhanced state transitions and animations, more intuitive layout and information display, and professional, polished appearance

### Actions Available
- [x] **Copy** - Copies transcription text to clipboard
- [x] **Paste** - Pastes transcription directly at cursor position
- [x] **New Recording** - Resets and starts a new recording session
- [x] **Cancel Recording** - Cancels current recording (Escape key)
- [x] **Restart Server** - Restart server with updated config
- [x] **Open Preferences** - Quick access to extension settings
- [x] **Enter key to stop** - Primary action triggered on Enter
- [x] **Edit transcription** - Modify text before copying or pasting

### Backend Features
- [x] **CUDA support** - GPU acceleration using NVIDIA CUDA
- [x] **CPU fallback** - Automatic fallback to CPU if CUDA unavailable
- [x] **Model selection** - Configurable via preferences (tiny, base, small, medium, large)
- [x] **Device selection** - CUDA or CPU via preferences
- [x] **CUDNN integration** - Automatic DLL path resolution for Windows
- [x] **Multi-language detection** - Auto-detects language from audio
- [x] **FastAPI server** - RESTful API for transcription requests
- [x] **Graceful shutdown** - Server can be stopped via API

### Configuration (All via Raycast Preferences)
- [x] **Backend directory** - Directory picker for Python backend location
- [x] **Server port** - Configurable port (default: 51234)
- [x] **Auto-start toggle** - Enable/disable auto-start recording
- [x] **Model selection** - Dropdown: tiny, base, small, medium, large
- [x] **Device selection** - Dropdown: CUDA (GPU) or CPU

---

## ❌ Not Implemented / TODO

### User Experience Improvements
- [ ] **Auto-action after transcription** - Option to automatically execute an action (e.g., paste, copy) when transcription completes. Default: none. E.g. If set to "paste", it behaves as if the user clicked paste immediately after finishing transcription.

### Error Handling & Robustness
- [ ] **Better error messages** - More specific error handling and user-friendly messages
- [ ] **Model download progress** - Show progress during initial model download
- [ ] **Server crash recovery** - Auto-restart server if it crashes

---

## 🔮 Future Features

These are ideas and enhancements that are not part of the current development scope. They represent potential future directions for the extension but are not planned for immediate implementation. These features may require significant architectural changes, additional dependencies, or external services, and are documented here for future reference and planning purposes.

### Post-Transcription LLM Processing
- [ ] **LLM-based text transformation** - Pipe transcription output through an LLM to perform intelligent transformations. For example, when user says "open parentheses", the LLM would transform it to "(" instead of the literal text. This would enable natural voice commands for punctuation, symbols, and formatting that users actually want in their text.

### Transcription History
- [ ] **Save previous transcriptions** - Simple feature to save and access previous transcriptions for quick copy/paste. This is not intended to be a full transcription manager, but rather a lightweight way to keep recent transcriptions accessible. Should leverage Raycast's built-in storage APIs (e.g., LocalStorage) and Node.js file system capabilities where appropriate. Users could access saved transcriptions to quickly copy or paste them without needing to re-record.

### Live Transcription Viewing
- [ ] **Live transcription preview** - A fun and nice-to-have feature that provides real-time transcription feedback while recording. User selects a different (smaller) model specifically for live transcription. During recording, the system repeatedly sends growing audio chunks to this smaller model and continuously displays the latest transcription text. This provides immediate visual feedback of what's being transcribed. When recording stops, the complete audio is still sent to the main selected (larger) model for the final, high-quality transcription. This allows users to see live text updates during recording while still getting the accuracy of the full model at the end.

---

## 🔧 Technical Implementation

### Frontend (TypeScript/React)
- `transcribe.tsx` - Main command component with state management
- `config.ts` - Configuration and preferences handling
- `transcription-client.ts` - HTTP client for backend API
- `server-manager.ts` - Python server lifecycle management

### Backend (Python/FastAPI)
- `transcription_server.py` - FastAPI server with Whisper integration
- `pyproject.toml` - Python dependencies

### Architecture
```
Raycast Command (transcribe.tsx)
  ├─> Checks AUTO_START preference
  ├─> ServerManager ensures Python server is running with correct config
  ├─> TranscriptionClient calls /record/start
  └─> On stop: calls /record/stop → gets transcription

Python Backend (transcription_server.py)
  ├─> FastAPI server on localhost:51234
  ├─> Config via command line args (model, device, port)
  ├─> /record/start - Starts sounddevice recording thread
  ├─> /record/stop - Stops recording, transcribes with Whisper
  ├─> /config - Returns current config
  ├─> /shutdown - Graceful shutdown for restart
  └─> Uses faster-whisper with CUDA or CPU
```

### Key Files
- `src/transcribe.tsx` - Main UI component
- `src/config.ts` - Preferences handling and config fingerprinting
- `src/server-manager.ts` - Server lifecycle with restart support
- `src/transcription-client.ts` - API client
- `backend/transcription_server.py` - Python backend
- `backend/pyproject.toml` - Python dependencies

---

## 📋 Configuration Reference

All configuration is done via Raycast Extension Preferences (no environment variables):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Backend Directory | Directory | (required) | Path to Python backend folder |
| Server Port | Text | 51234 | Local server port |
| Auto-start Recording | Checkbox | ✓ On | Start recording when command opens |
| Whisper Model | Dropdown | Base | Model size (tiny/base/small/medium/large) |
| Compute Device | Dropdown | CUDA | GPU (CUDA) or CPU |

---

## 🚀 Quick Reference

### Server Restart
When you change model or device settings, the server will automatically restart when you start a new recording. You can also manually restart via the "Restart Server" action.

### Model Sizes
- **Tiny**: ~39MB, fastest, least accurate
- **Base**: ~74MB, good balance for quick transcriptions
- **Small**: ~244MB, better accuracy
- **Medium**: ~769MB, high accuracy
- **Large-v3**: ~1.5GB, best accuracy, slowest

### CPU vs CUDA
- **CUDA**: Requires NVIDIA GPU with CUDA support. Much faster.
- **CPU**: Works on any system. Slower but no GPU needed.

If CUDA is selected but unavailable, the server automatically falls back to CPU.

---

## 📚 Dependencies

### Frontend
- `@raycast/api` - Raycast extension API
- `axios` - HTTP client
- `execa` - Process execution

### Backend
- `faster-whisper` - Optimized Whisper implementation
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `sounddevice` - Audio recording
- `soundfile` - Audio file I/O

---

_Last Updated: November 2024_
