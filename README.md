# Voice Transcription - Raycast Extension

A high-performance Raycast extension for Windows that records audio and transcribes it locally using [Whisper](https://github.com/openai/whisper) (via `faster-whisper`) with CUDA GPU acceleration.

## 🚀 Features

- **Local Transcription**: Privacy-focused, runs entirely on your machine.
- **CUDA Acceleration**: Uses NVIDIA GPU for lightning-fast transcription.
- **One-Click Workflow**: Record -> Transcribe -> Copy/Paste.
- **Auto-Start**: Server automatically starts when you use the extension.
- **Multi-Language**: Auto-detects languages (Whisper supports 99+ languages).
- **Customizable**: Choose your model size (Tiny to Large) and compute device (CUDA/CPU).

## 📋 Prerequisites

1.  **Windows** (The extension uses specific Windows APIs for process management).
2.  **Raycast** for Windows.
3.  **Python 3.10+** installed.
4.  **UV** (Python package manager) - [Installation Guide](https://github.com/astral-sh/uv).
    ```powershell
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    ```
5.  **NVIDIA GPU** (Optional but recommended for speed).
    *   Requires [CUDA Toolkit 12.x](https://developer.nvidia.com/cuda-downloads).
    *   Requires [cuDNN 9.x](https://developer.nvidia.com/cudnn) (The backend automatically adds cuDNN to the path if found in standard locations).

## 🛠️ Installation

### 1. Clone and Install Extension

```bash
# Install frontend dependencies
bun install
```

### 2. Install Backend Dependencies

The backend handles recording and transcription. It uses `uv` for fast dependency management.

```bash
cd backend
uv sync
```

This installs:
- `faster-whisper`: Optimized Whisper implementation.
- `fastapi` & `uvicorn`: API server.
- `sounddevice`: Audio recording.

## 🎮 Usage

1.  Open Raycast and search for **"Transcribe Voice"**.
2.  **Start Recording**:
    *   If "Auto-start" is enabled (default), recording begins immediately.
    *   Otherwise, press `Enter` to start.
3.  **Speak** your text.
4.  **Stop**: Press `Enter` again or select "Stop & Transcribe".
5.  **Result**:
    *   **Copy**: Press `Enter`.
    *   **Paste**: Press `Shift + Enter` to paste directly into the active window.
    *   **Edit**: Press `Cmd/Ctrl + E` to make corrections before copying.

## ⚙️ Configuration

Go to **Raycast Settings** > **Extensions** > **Voice Transcription** to configure:

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Backend Directory** | **Required**. Path to the `backend` folder in this project. | |
| **Whisper Model** | Model size (`tiny`, `base`, `small`, `medium`, `large-v3`). Larger models are more accurate but slower. | `base` |
| **Compute Device** | `CUDA` (GPU) or `CPU`. CUDA is significantly faster. | `CUDA` |
| **Auto-start** | Start recording immediately when the command is opened. | `true` |
| **Server Port** | Port for the local transcription server. | `51234` |

## 🏗️ Architecture

The extension operates as a hybrid system:

1.  **Frontend (TypeScript)**: A Raycast UI that manages the user interaction and state.
2.  **Backend (Python)**: A local FastAPI server managed by the frontend.
    *   **Server Manager**: The frontend checks if the server is running on the specified port. If not, it launches `uv run python transcription_server.py`.
    *   **Recording**: Audio is captured by the Python backend using `sounddevice` (PortAudio) to a temporary WAV file.
    *   **Transcription**: When recording stops, `faster-whisper` processes the WAV file and returns the text.

## 🔧 Troubleshooting

### Server fails to start
*   Check the "Backend Directory" setting in Raycast preferences. It must point to the folder containing `transcription_server.py`.
*   Ensure `uv` is in your system PATH.
*   Run `uv sync` in the `backend` directory manually to ensure dependencies are installed.

### "Model not loaded" or CUDA errors
*   If using CUDA, ensure you have NVIDIA drivers and CUDA Toolkit installed.
*   If CUDA fails, the server attempts to fallback to CPU. Check the extension display to see if it says `cpu`.
*   The first run might take longer as it downloads the Whisper model.

### Recording issues
*   Ensure your default microphone is set correctly in Windows Sound Settings.
*   The backend uses `sounddevice`, which connects to the default input device.

## 📜 License

[GNU GPLv3](LICENSE)
