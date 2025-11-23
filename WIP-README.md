# Voice Transcription - Raycast Extension (WIP)

**Status**: Work in Progress  
**Platform**: Windows Only  
**Purpose**: Quick-access, high-quality, local-only transcription using Whisper models with CUDA GPU acceleration

---

## 🎯 Core Use Case

A Raycast extension that provides **very quickly accessible**, **very high quality**, **local-only** transcription. When the Raycast command is selected, it should:
1. Auto-start listening (toggleable)
2. Stop on Enter press
3. Save temp files and run through the Whisper model
4. Show transcribed text with action options (Copy, Paste, Edit)

---

## ✅ Implemented Features

### Core Functionality
- [x] **Auto-start recording** - Extension automatically starts recording when command is opened
- [x] **Backend recording** - Python backend handles microphone capture using `sounddevice`
- [x] **Whisper transcription** - Uses `faster-whisper` for CUDA-accelerated transcription
- [x] **Temporary file handling** - Records to temp directory, cleans up after transcription
- [x] **Server management** - Auto-starts Python backend server if not running
- [x] **Health checks** - Server health monitoring and status checks

### User Interface
- [x] **Recording states** - Visual feedback for: idle, checking server, starting server, recording, processing, completed, error
- [x] **Action panel** - Context-aware actions based on current state
- [x] **Toast notifications** - User feedback for all operations
- [x] **Result display** - Shows transcription text, detected language, and duration

### Actions Available
- [x] **Copy to Clipboard** - Copies transcription text to clipboard
- [x] **Paste at Cursor** - Pastes transcription directly at cursor position
- [x] **New Recording** - Resets and starts a new recording session
- [x] **Cancel Recording** - Cancels current recording without transcribing
- [x] **Check Server** - Manually check server status
- [x] **Enter key to stop** - Raycast automatically triggers primary action (Stop Recording) on Enter key press

### Backend Features
- [x] **CUDA support** - GPU acceleration using NVIDIA CUDA
- [x] **CUDNN integration** - Automatic DLL path resolution for Windows
- [x] **Model loading** - Automatic model download and caching
- [x] **Multi-language detection** - Auto-detects language from audio
- [x] **FastAPI server** - RESTful API for transcription requests
- [x] **CORS enabled** - Allows local development

### Configuration
- [x] **Backend directory** - Configurable via Raycast preferences (`directory` type) (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [x] **Server port** - Configurable via Raycast preferences (`textfield` type, default: 51234) (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [x] **Model selection** - Via `WHISPER_MODEL` environment variable (tiny, base, small, medium, large) - *TODO: Move to UI preference*

---

## ❌ Not Implemented / TODO

### Critical Missing Features
- [ ] **Auto-start toggle** - Always auto-starts recording. Need preference setting to disable auto-start (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [ ] **Model size selection in UI** - Currently only via environment variable. Need dropdown/preference in Raycast settings (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [ ] **CPU fallback option** - Hardcoded to CUDA. Need device selection (CUDA/CPU) with automatic fallback
- [ ] **Edit transcription** - Mentioned but not implemented. Need text editor view/action

### Configuration & Preferences
- [ ] **Auto-start preference** - Toggle (`checkbox` type) to enable/disable auto-start recording (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [ ] **Model size preference** - UI dropdown (`dropdown` type) for model selection (tiny/base/small/medium/large) (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- [ ] **Device preference** - CUDA/CPU selection (`dropdown` type) with auto-fallback (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))

### User Experience Improvements
- [ ] **Recording timer** - Show elapsed recording time during capture
- [ ] **Audio level indicator** - Visual feedback of microphone input level
- [ ] **Silence detection** - Auto-stop after period of silence (optional)
- [ ] **Recording history** - Save/access previous transcriptions
- [ ] **Export options** - Save transcriptions to file (txt, markdown, etc.)

### Error Handling & Robustness
- [ ] **CUDA fallback** - Automatic fallback to CPU if CUDA unavailable (with warning message to user)
- [ ] **Better error messages** - More specific error handling and user-friendly messages
- [ ] **Model download progress** - Show progress during initial model download (also with model is switched, etc.)
- [ ] **Server crash recovery** - Auto-restart server if it crashes

---

## 🔍 Technical Checks

### Audio Processing
- [ ] **Audio level normalization** - Verify that audio levels are normalized before being passed to the Whisper model (should be normalized)


---

## 🔧 Technical Implementation Status

### Frontend (TypeScript/React)
- ✅ `transcribe.tsx` - Main command component with state management
- ✅ `audio-recorder.ts` - Windows audio recording (currently unused, backend handles it)
- ✅ `transcription-client.ts` - HTTP client for backend API
- ✅ `server-manager.ts` - Python server lifecycle management
- ✅ `config.ts` - Configuration and preferences handling

### Backend (Python/FastAPI)
- ✅ `transcription_server.py` - FastAPI server with Whisper integration
- ✅ `pyproject.toml` - Python dependencies (faster-whisper, fastapi, sounddevice, etc.)
- ✅ CUDA/CUDNN DLL path resolution for Windows
- ✅ Backend recording using `sounddevice` (replaces frontend SoX dependency)

### Architecture Notes
- **Recording**: Currently handled entirely by Python backend (`/record/start` and `/record/stop` endpoints)
- **Audio Format**: WAV files, 16kHz sample rate, mono channel
- **Model Storage**: Uses default `faster-whisper` cache directory
- **Server Lifecycle**: Auto-starts on first use, stays running for subsequent uses

---

## 📋 Planned Features (To Be Discussed)

_Leave space here for additional features you want to add..._

---

## 🐛 Known Issues

1. **Always auto-starts** - No way to disable auto-start recording
2. **CUDA only** - No CPU fallback if CUDA unavailable
3. **Model selection** - Only via environment variable, not user-friendly
4. **No edit option** - Can't edit transcription before copying/pasting

---

## 📝 Development Notes

### Current Architecture
```
Raycast Command (transcribe.tsx)
  ├─> Auto-starts recording on mount
  ├─> ServerManager ensures Python server is running
  ├─> TranscriptionClient calls /record/start
  └─> On stop: TranscriptionClient calls /record/stop → gets transcription

Python Backend (transcription_server.py)
  ├─> FastAPI server on localhost:51234
  ├─> /record/start - Starts sounddevice recording thread
  ├─> /record/stop - Stops recording, transcribes with Whisper
  └─> Uses faster-whisper with CUDA acceleration
```

### Key Files
- `src/transcribe.tsx` - Main UI component
- `src/server-manager.ts` - Server lifecycle
- `src/transcription-client.ts` - API client
- `backend/transcription_server.py` - Python backend
- `backend/pyproject.toml` - Python dependencies

### Environment Variables
- `WHISPER_MODEL` - Model size (tiny/base/small/medium/large), default: "base"
- `WHISPER_SERVER_HOST` - Server host, default: "127.0.0.1"
- `WHISPER_SERVER_PORT` - Server port, default: "51234"

---

## 🚀 Quick Reference

### Enter Key Support
- ✅ **Already works!** Raycast automatically triggers the primary action (first action in ActionPanel) when Enter is pressed. No additional code needed.

### To Add Auto-Start Toggle
- Add `checkbox` preference in `package.json` preferences array (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- Read preference using `getPreferenceValues<Preferences.Transcribe>()` in `transcribe.tsx`
- Conditionally call `checkServerAndStartRecording()` in useEffect based on preference value

### To Add Model Selection UI
- Add `dropdown` preference in `package.json` with options: tiny, base, small, medium, large (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
- Read preference using `getPreferenceValues<Preferences.Transcribe>()` 
- Pass model to server via environment variable in `server-manager.ts` when starting server
- Server reads from env var on startup (already implemented)

### To Add CPU Fallback
- Modify `transcription_server.py` to detect CUDA availability
- Fall back to CPU if CUDA not available
- Add preference for forced CPU mode

### To Add Edit Option
- Create new state/view for editing transcription
- Use Raycast Form or Detail with editable text
- Add "Edit" action that transitions to edit view
- Add "Save" action that updates transcription

---

## 📚 Dependencies & Documentation

### Frontend
- `@raycast/api` - Raycast extension API ([Raycast API Docs](https://developers.raycast.com))
- `axios` - HTTP client
- `execa` - Process execution for Python server

### Raycast API References
- [Preferences API](https://developers.raycast.com/api-reference/preferences) - For adding configuration options
- [Raycast Developer Docs](https://developers.raycast.com) - Complete API reference and guides

### Backend
- `faster-whisper` - Optimized Whisper implementation
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `sounddevice` - Audio recording
- `soundfile` - Audio file I/O
- `nvidia-cudnn-cu12` - CUDA deep neural network library
- `nvidia-cublas-cu12` - CUDA basic linear algebra library

---

## 🎯 Priority TODO List

1. **High Priority**
   - [ ] Add auto-start toggle preference (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))
   - [ ] Add CPU fallback for non-CUDA systems
   - [ ] Add model size selection in UI (see [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences))

2. **Medium Priority**
   - [ ] Add edit transcription feature
   - [ ] Improve error handling and messages
   - [ ] Add recording timer display
   - [ ] Add additional keyboard shortcuts (Escape to cancel, etc.)

3. **Low Priority**
   - [ ] Recording history
   - [ ] Export options
   - [ ] Audio level indicator
   - [ ] Silence detection

---

_Last Updated: [Current Date]_

