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
import soundfile as sf
import threading
import queue
import time
import numpy as np

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

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
    return parser.parse_args()

# Server configuration (will be set from command line args)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 51234
    model_size: str = "base"
    device: str = "cuda"
    compute_type: str = "float16"
    
    @classmethod
    def from_args(cls, args):
        cls.host = args.host
        cls.port = args.port
        cls.model_size = args.model
        cls.device = args.device
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

# Global model and recording state
model: Optional[WhisperModel] = None
model_load_error: Optional[str] = None

recording_thread: Optional[threading.Thread] = None
recording_stop_event: Optional[threading.Event] = None
recording_file_path: Optional[str] = None
recording_start_time: Optional[float] = None

# Audio level tracking (thread-safe)
audio_level: float = 0.0
audio_level_lock: threading.Lock = threading.Lock()


def check_cuda_available() -> bool:
    """Check if CUDA is available"""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        # If torch isn't available, try loading model and see what happens
        return True  # Optimistic - faster-whisper will handle it


def load_model():
    """Load the Whisper model with configured device"""
    global model, model_load_error
    
    if model is not None:
        return
    
    device = config.device
    compute_type = config.compute_type
    
    # Try CUDA first, fall back to CPU if it fails
    if device == "cuda":
        try:
            logger.info(f"Loading Whisper model: {config.model_size} on cuda with {compute_type}")
            model = WhisperModel(
                config.model_size,
                device="cuda",
                compute_type=compute_type,
                download_root=None,
            )
            logger.info("Model loaded successfully on CUDA")
            return
        except Exception as e:
            logger.warning(f"CUDA load failed: {e}, falling back to CPU")
            device = "cpu"
            compute_type = "int8"
    
    # CPU fallback or explicit CPU mode
    try:
        logger.info(f"Loading Whisper model: {config.model_size} on cpu with {compute_type}")
        model = WhisperModel(
            config.model_size,
            device="cpu",
            compute_type=compute_type,
            download_root=None,
        )
        # Update config to reflect actual device used
        config.device = "cpu"
        config.compute_type = compute_type
        logger.info("Model loaded successfully on CPU")
    except Exception as e:
        model_load_error = str(e)
        logger.error(f"Failed to load model: {e}")
        raise


def _record_audio_worker(file_path: str, stop_event: threading.Event, samplerate: int = 16000, channels: int = 1):
    """Background worker that records from default microphone to a WAV file"""
    q: "queue.Queue[bytes]" = queue.Queue()

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
        
        q.put(indata.copy())

    try:
        logger.info(f"Starting audio recording to {file_path}")
        with sf.SoundFile(file_path, mode="w", samplerate=samplerate, channels=channels) as f:
            with sd.InputStream(samplerate=samplerate, channels=channels, callback=callback):
                while not stop_event.is_set():
                    try:
                        data = q.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    f.write(data)
        logger.info("Audio recording stopped")
    except Exception as e:
        logger.error(f"Audio recording failed: {e}")


@app.on_event("startup")
async def startup_event():
    """Initialize model on server startup"""
    load_model()
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
        "recording": recording_thread is not None and recording_thread.is_alive(),
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
    global recording_thread, recording_stop_event, recording_file_path, recording_start_time, audio_level

    if recording_thread is not None and recording_thread.is_alive():
        raise HTTPException(status_code=400, detail="Recording already in progress")

    temp_dir = tempfile.gettempdir()
    recording_file_path = os.path.join(temp_dir, "whisper_recording.wav")

    try:
        if os.path.exists(recording_file_path):
            os.unlink(recording_file_path)
    except Exception:
        pass

    # Reset audio level
    with audio_level_lock:
        audio_level = 0.0

    recording_stop_event = threading.Event()
    recording_thread = threading.Thread(
        target=_record_audio_worker,
        args=(recording_file_path, recording_stop_event),
        daemon=True,
    )
    recording_start_time = time.time()
    recording_thread.start()

    logger.info("Recording started")
    return {"status": "recording_started"}


@app.get("/record/level")
async def get_audio_level():
    """Get current audio level (0.0 to 1.0)"""
    global audio_level
    
    with audio_level_lock:
        level = audio_level
    
    return {"level": level}


@app.post("/record/stop")
async def stop_recording_and_transcribe():
    """Stop recording and transcribe"""
    global recording_thread, recording_stop_event, recording_file_path, recording_start_time, audio_level

    if recording_thread is None or recording_stop_event is None or recording_file_path is None:
        raise HTTPException(status_code=400, detail="No recording in progress")

    recording_stop_event.set()
    recording_thread.join(timeout=5.0)

    recording_thread = None
    recording_stop_event = None
    
    # Reset audio level when recording stops
    with audio_level_lock:
        audio_level = 0.0

    if not os.path.exists(recording_file_path):
        raise HTTPException(status_code=500, detail="Recorded file not found")

    if model is None:
        raise HTTPException(status_code=503, detail=model_load_error or "Model not loaded")

    duration = time.time() - recording_start_time if recording_start_time else 0.0
    recording_start_time = None

    try:
        logger.info(f"Transcribing recorded audio")
        segments, info = model.transcribe(
            recording_file_path,
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
        try:
            if os.path.exists(recording_file_path):
                os.unlink(recording_file_path)
        except Exception:
            pass


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
            "POST /record/stop - Stop recording and transcribe",
            "POST /shutdown - Gracefully stop server",
        ]
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
