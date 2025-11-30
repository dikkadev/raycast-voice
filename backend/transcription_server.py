"""
Whisper Transcription Server with CUDA/CPU Support
Provides HTTP API for audio transcription using faster-whisper
Configuration is passed via API - no environment variables needed
"""

import os
import logging
import sys
from pathlib import Path
from typing import Optional
import tempfile

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# On Windows, we must explicitly add the NVIDIA libraries to the DLL search path
if os.name == 'nt':
    cudnn_base = r"C:\Program Files\NVIDIA\CUDNN\v9.16\bin"
    if os.path.exists(cudnn_base):
        cuda_versions = ["13.0", "12.9", "12.8", "12.7", "12.6", "12.5", "12.4", "12.3", "12.2", "12.1", "12.0"]
        for cuda_version in cuda_versions:
            cudnn_path = os.path.join(cudnn_base, cuda_version)
            if os.path.exists(cudnn_path):
                os.add_dll_directory(cudnn_path)
                os.environ["PATH"] = cudnn_path + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel

import sounddevice as sd
import threading
import time
import numpy as np

# Audio / preview configuration
RECORDER_SAMPLERATE = 16000
RECORDER_CHANNELS = 1
LIVE_PREVIEW_MIN_DURATION = 1.0  # seconds

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class SuppressAudioLevelAccess(logging.Filter):
    """Filter uvicorn access logs to avoid spamming /record/level hits."""

    TARGET_PATH = "/record/level"

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # Keep log if we cannot parse or if it's not the audio level endpoint
        return self.TARGET_PATH not in message


logging.getLogger("uvicorn.access").addFilter(SuppressAudioLevelAccess())

# Parse command line arguments for configuration
def parse_args():
    """Parse command line arguments for server configuration"""
    import argparse
    parser = argparse.ArgumentParser(description="Whisper Transcription Server")
    parser.add_argument("--host", default="127.0.0.1", help="Server host")
    parser.add_argument("--port", type=int, default=51234, help="Server port")
    parser.add_argument("--model", default="base", help="Whisper model size")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"], help="Compute device")
    parser.add_argument("--compute-type", default=None, help="Compute type (auto-detected if not set)")
    parser.add_argument("--live-model", default="tiny", help="Whisper model used for live preview")
    return parser.parse_args()

# Server configuration (will be set from command line args)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 51234
    model_size: str = "base"
    device: str = "cuda"
    compute_type: str = "float16"
    live_model: str = "tiny"
    
    @classmethod
    def from_args(cls, args):
        cls.host = args.host
        cls.port = args.port
        cls.model_size = args.model
        cls.device = args.device
        cls.live_model = args.live_model or "tiny"
        # Auto-detect compute type based on device
        if args.compute_type:
            cls.compute_type = args.compute_type
        else:
            cls.compute_type = "float16" if args.device == "cuda" else "int8"
        return cls

config = ServerConfig()

app = FastAPI(title="Whisper Transcription Server")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Build identifier used by the Raycast extension to ensure backend/frontend compatibility
SERVER_BUILD_ID = "2025-11-29-cancel-endpoint"

# Global model and recording state
model: Optional[WhisperModel] = None
model_load_error: Optional[str] = None
live_model_instance: Optional[WhisperModel] = None
live_model_load_error: Optional[str] = None

recording_thread: Optional[threading.Thread] = None
recording_stop_event: Optional[threading.Event] = None
recording_audio_buffer: Optional[list] = None
recording_buffer_lock: Optional[threading.Lock] = None
recording_start_time: Optional[float] = None

# Audio level tracking (thread-safe)
audio_level: float = 0.0
audio_level_lock: threading.Lock = threading.Lock()


def _stop_recording_thread():
    """Helper to stop the background recording thread safely"""
    global recording_thread, recording_stop_event, audio_level

    if recording_stop_event:
        recording_stop_event.set()

    if recording_thread and recording_thread.is_alive():
        recording_thread.join(timeout=5.0)

    recording_thread = None
    recording_stop_event = None

    with audio_level_lock:
        # Reset cached audio level so frontend meters clear immediately
        audio_level = 0.0


def _clear_recording_buffer():
    """Clear the in-memory audio buffer"""
    global recording_audio_buffer, recording_buffer_lock

    if recording_buffer_lock:
        with recording_buffer_lock:
            recording_audio_buffer = None
    else:
        recording_audio_buffer = None
    
    recording_buffer_lock = None


def _copy_recording_audio() -> Optional[np.ndarray]:
    """Snapshot the current in-memory audio buffer"""
    global recording_audio_buffer, recording_buffer_lock

    if recording_audio_buffer is None or recording_buffer_lock is None:
        return None

    with recording_buffer_lock:
        if not recording_audio_buffer:
            return None
        copied_chunks = [chunk.copy() for chunk in recording_audio_buffer]

    audio_data = np.concatenate(copied_chunks, axis=0)
    if audio_data.dtype != np.float32:
        audio_data = audio_data.astype(np.float32)
    return audio_data


def check_cuda_available() -> bool:
    """Check if CUDA is available"""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        # If torch isn't available, try loading model and see what happens
        return True  # Optimistic - faster-whisper will handle it


def _load_whisper_model_instance(model_name: str, preferred_device: str, preferred_compute: str, tag: str):
    """Load a Whisper model, falling back to CPU when CUDA fails."""
    device = preferred_device
    compute_type = preferred_compute

    if device == "cuda":
        try:
            logger.info(f"Loading {tag} model: {model_name} on cuda with {compute_type}")
            instance = WhisperModel(
                model_name,
                device="cuda",
                compute_type=compute_type,
                download_root=None,
            )
            logger.info(f"{tag.title()} model loaded on CUDA")
            return instance, "cuda", compute_type
        except Exception as e:
            logger.warning(f"{tag.title()} CUDA load failed: {e}, falling back to CPU")
            device = "cpu"
            compute_type = "int8"

    try:
        logger.info(f"Loading {tag} model: {model_name} on cpu with {compute_type}")
        instance = WhisperModel(
            model_name,
            device="cpu",
            compute_type=compute_type,
            download_root=None,
        )
        logger.info(f"{tag.title()} model loaded on CPU")
        return instance, "cpu", compute_type
    except Exception as e:
        logger.error(f"Failed to load {tag} model: {e}")
        raise


def load_models():
    """Load primary and live preview Whisper models"""
    global model, live_model_instance, model_load_error, live_model_load_error

    if model is None:
        try:
            primary_model, actual_device, actual_compute = _load_whisper_model_instance(
                config.model_size,
                config.device,
                config.compute_type,
                tag="primary",
            )
            model = primary_model
            config.device = actual_device
            config.compute_type = actual_compute
            model_load_error = None
        except Exception as e:
            model_load_error = str(e)
            raise

    if live_model_instance is None:
        if config.live_model == config.model_size:
            live_model_instance = model
            live_model_load_error = None
            logger.info("Live preview reusing primary model instance")
            return

        preferred_device = config.device
        preferred_compute = config.compute_type if config.device == "cuda" else "int8"

        try:
            preview_model, _, _ = _load_whisper_model_instance(
                config.live_model,
                preferred_device,
                preferred_compute,
                tag="live preview",
            )
            live_model_instance = preview_model
            live_model_load_error = None
        except Exception as e:
            live_model_load_error = str(e)
            # Do not raise - live preview is optional
            logger.error(f"Failed to load live preview model: {e}")


def _record_audio_worker(
    stop_event: threading.Event,
    audio_buffer: list,
    buffer_lock: threading.Lock,
    samplerate: int = RECORDER_SAMPLERATE,
    channels: int = RECORDER_CHANNELS,
):
    """Background worker that records from default microphone to an in-memory buffer"""
    def callback(indata, frames, time_info, status):
        global audio_level
        if status:
            logger.warning(f"Recording status: {status}")
        # Calculate RMS (Root Mean Square) audio level
        # indata is a numpy array of shape (frames, channels) in range [-1.0, 1.0]
        rms = np.sqrt(np.mean(indata**2))
        # Return raw RMS value - normalization will be done on frontend
        audio_level_value = float(rms)
        
        with audio_level_lock:
            audio_level = audio_level_value
        
        # Append audio chunk to buffer (thread-safe)
        with buffer_lock:
            audio_buffer.append(indata.copy())

    try:
        logger.info("Starting audio recording to memory buffer")
        with sd.InputStream(samplerate=samplerate, channels=channels, callback=callback):
            while not stop_event.is_set():
                time.sleep(0.1)  # Just wait, callback handles everything
        logger.info("Audio recording stopped")
    except Exception as e:
        logger.error(f"Audio recording failed: {e}")


@app.on_event("startup")
async def startup_event():
    """Initialize model on server startup"""
    load_models()
    logger.info(f"Server ready on {config.host}:{config.port}")
    logger.info(f"Config: model={config.model_size}, device={config.device}, compute_type={config.compute_type}")


@app.get("/health")
async def health_check():
    """Health check endpoint with full config info"""
    return {
        "status": "healthy" if model is not None else "error",
        "model": config.model_size,
        "device": config.device,
        "compute_type": config.compute_type,
        "model_loaded": model is not None,
        "model_error": model_load_error,
        "live_model": config.live_model,
        "live_model_loaded": live_model_instance is not None,
        "live_model_error": live_model_load_error,
        "recording": recording_thread is not None and recording_thread.is_alive(),
        "build_id": SERVER_BUILD_ID,
    }


@app.get("/config")
async def get_config():
    """Get current server configuration"""
    return {
        "model": config.model_size,
        "device": config.device,
        "compute_type": config.compute_type,
        "host": config.host,
        "port": config.port,
    }


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe uploaded audio file"""
    if model is None:
        raise HTTPException(status_code=503, detail=model_load_error or "Model not loaded")

    temp_file = None
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "audio.wav").suffix) as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_path = temp_file.name

        logger.info(f"Transcribing uploaded audio: {len(content)} bytes")

        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            language=None,
            task="transcribe",
        )

        transcription = " ".join([segment.text for segment in segments])

        logger.info(f"Transcription completed: {len(transcription)} chars")

        return JSONResponse({
            "text": transcription.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        })

    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except Exception:
                pass


@app.post("/record/start")
async def start_recording():
    """Start recording from default microphone"""
    global recording_thread, recording_stop_event, recording_audio_buffer, recording_buffer_lock, recording_start_time, audio_level

    if recording_thread is not None and recording_thread.is_alive():
        raise HTTPException(status_code=400, detail="Recording already in progress")

    # Initialize in-memory audio buffer
    recording_audio_buffer = []
    recording_buffer_lock = threading.Lock()

    # Reset audio level
    with audio_level_lock:
        audio_level = 0.0

    recording_stop_event = threading.Event()
    recording_thread = threading.Thread(
        target=_record_audio_worker,
        args=(recording_stop_event, recording_audio_buffer, recording_buffer_lock),
        daemon=True,
    )
    recording_start_time = time.time()
    recording_thread.start()

    logger.info("Recording started (in-memory buffer)")
    return {"status": "recording_started"}


@app.get("/record/level")
async def get_audio_level():
    """Get current audio level (0.0 to 1.0)"""
    global audio_level
    
    with audio_level_lock:
        level = audio_level
    
    return {"level": level}


@app.post("/record/preview")
async def get_live_preview():
    """Return live transcription preview using the configured live model"""
    if recording_thread is None or recording_stop_event is None or recording_audio_buffer is None:
        return {"text": "", "error": "no_recording"}

    if live_model_instance is None:
        return {"text": "", "error": live_model_load_error or "live_model_not_loaded"}

    audio_data = _copy_recording_audio()
    if audio_data is None:
        return {"text": ""}

    duration_seconds = audio_data.shape[0] / RECORDER_SAMPLERATE
    if duration_seconds < LIVE_PREVIEW_MIN_DURATION:
        return {"text": ""}

    try:
        segments, _ = live_model_instance.transcribe(
            audio_data,
            beam_size=3,
            language=None,
            task="transcribe",
        )
        transcription = " ".join(segment.text for segment in segments).strip()
        return {"text": transcription}
    except Exception as e:
        logger.error(f"Live preview transcription failed: {e}")
        return {"text": "", "error": str(e)}


@app.post("/record/stop")
async def stop_recording_and_transcribe():
    """Stop recording and transcribe"""
    global recording_thread, recording_stop_event, recording_audio_buffer, recording_buffer_lock, recording_start_time, audio_level

    if recording_thread is None or recording_stop_event is None or recording_audio_buffer is None or recording_buffer_lock is None:
        raise HTTPException(status_code=400, detail="No recording in progress")

    _stop_recording_thread()

    if model is None:
        raise HTTPException(status_code=503, detail=model_load_error or "Model not loaded")

    duration = time.time() - recording_start_time if recording_start_time else 0.0
    recording_start_time = None

    try:
        # Concatenate all audio chunks into a single numpy array
        with recording_buffer_lock:
            if not recording_audio_buffer:
                raise HTTPException(status_code=500, detail="No audio data recorded")
            
            # Concatenate all chunks: each chunk is shape (frames, channels)
            audio_data = np.concatenate(recording_audio_buffer, axis=0)
            # Convert to float32 if needed (faster-whisper expects float32)
            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32)
            
            # Clear buffer after extracting data
            recording_audio_buffer = None
        
        logger.info(f"Transcribing recorded audio from memory buffer ({audio_data.shape[0]} frames)")
        
        # Transcribe directly from numpy array
        segments, info = model.transcribe(
            audio_data,
            beam_size=5,
            language=None,
            task="transcribe",
        )

        transcription = " ".join([segment.text for segment in segments])

        result = {
            "text": transcription.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration if hasattr(info, "duration") else duration,
        }

        logger.info(f"Transcription completed: {len(transcription)} chars, language: {info.language}")

        return JSONResponse(result)
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        _clear_recording_buffer()


@app.post("/record/cancel")
async def cancel_recording():
    """Cancel an in-progress recording without transcribing"""
    global recording_start_time

    if recording_thread is None or recording_stop_event is None:
        logger.info("Cancel requested but no active recording")
        return {"status": "no_recording"}

    _stop_recording_thread()
    _clear_recording_buffer()
    recording_start_time = None

    logger.info("Recording cancelled and buffer cleared")
    return {"status": "recording_cancelled"}


@app.post("/shutdown")
async def shutdown():
    """Gracefully shutdown the server"""
    logger.info("Shutdown requested")
    # Schedule shutdown after response is sent
    import asyncio
    asyncio.get_event_loop().call_later(0.5, lambda: os._exit(0))
    return {"status": "shutting_down"}


@app.get("/")
async def root():
    """Root endpoint with API info"""
    return {
        "name": "Whisper Transcription Server",
        "version": "0.2.0",
        "config": {
            "model": config.model_size,
            "device": config.device,
        },
        "endpoints": [
            "GET  /health - Server health and status",
            "GET  /config - Current configuration",
            "POST /transcribe - Transcribe uploaded audio",
            "POST /record/start - Start recording",
            "GET  /record/level - Get current audio level (0.0-1.0)",
            "POST /record/preview - Live preview transcription",
            "POST /record/stop - Stop recording and transcribe",
            "POST /record/cancel - Cancel recording without transcribing",
            "POST /shutdown - Gracefully stop server",
        ],
        "build_id": SERVER_BUILD_ID,
    }


if __name__ == "__main__":
    import uvicorn
    
    args = parse_args()
    ServerConfig.from_args(args)
    
    logger.info(f"Starting Whisper Transcription Server")
    logger.info(f"  Host: {config.host}:{config.port}")
    logger.info(f"  Model: {config.model_size}")
    logger.info(f"  Device: {config.device}")
    logger.info(f"  Compute Type: {config.compute_type}")
    
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level="info"
    )
