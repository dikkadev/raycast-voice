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
import gc

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
    parser.add_argument("--model", default="large-v3-turbo", help="Whisper model size")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"], help="Compute device")
    parser.add_argument("--compute-type", default=None, help="Compute type (auto-detected if not set)")
    return parser.parse_args()

# Server configuration (will be set from command line args)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 51234
    model_size: str = "large-v3-turbo"
    device: str = "cuda"
    compute_type: str = "int8_float16"
    
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
            cls.compute_type = "int8_float16" if args.device == "cuda" else "int8"
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
SERVER_BUILD_ID = "2025-01-28-turbo-int8"

# Global model and recording state
model: Optional[WhisperModel] = None
model_load_error: Optional[str] = None

SAMPLE_RATE = 16000
CHANNELS = 1
MAX_RECORDING_SECONDS = 600  # Hard cap to avoid runaway memory use
MAX_RECORDING_FRAMES = SAMPLE_RATE * MAX_RECORDING_SECONDS

# Cached recording (post-transcription) so we can re-run without re-recording
LAST_RECORDING_KEEP_SECONDS = 60.0
last_recording_audio: Optional[np.ndarray] = None
last_recording_overrun: bool = False
last_recording_frames: int = 0
last_recording_clear_timer: Optional[threading.Timer] = None

recording_thread: Optional[threading.Thread] = None
recording_stop_event: Optional[threading.Event] = None
recording_start_time: Optional[float] = None

recording_audio_chunks: Optional[list[np.ndarray]] = None
recording_total_frames: int = 0
recording_overrun: bool = False
recording_audio_lock: threading.Lock = threading.Lock()

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


def _init_audio_buffer():
    """Prepare an empty audio buffer for a new recording session."""
    global recording_audio_chunks, recording_total_frames, recording_overrun
    with recording_audio_lock:
        recording_audio_chunks = []
        recording_total_frames = 0
        recording_overrun = False


def _consume_audio_buffer():
    """Return recorded audio chunks and reset the buffer."""
    global recording_audio_chunks, recording_total_frames, recording_overrun
    with recording_audio_lock:
        chunks = recording_audio_chunks
        total_frames = recording_total_frames
        overrun = recording_overrun
        recording_audio_chunks = None
        recording_total_frames = 0
        recording_overrun = False
    return chunks, total_frames, overrun


def _clear_audio_buffer():
    """Discard any recorded audio data."""
    global recording_audio_chunks, recording_total_frames, recording_overrun
    with recording_audio_lock:
        recording_audio_chunks = None
        recording_total_frames = 0
        recording_overrun = False


def _clear_last_recording_audio():
    """Discard cached audio from the last completed recording."""
    global last_recording_audio, last_recording_overrun, last_recording_frames, last_recording_clear_timer

    with recording_audio_lock:
        last_recording_audio = None
        last_recording_overrun = False
        last_recording_frames = 0

    if last_recording_clear_timer:
        last_recording_clear_timer.cancel()
        last_recording_clear_timer = None


def _schedule_last_recording_clear():
    """Schedule clearing the cached audio after the keepalive window."""
    global last_recording_clear_timer

    if last_recording_clear_timer:
        last_recording_clear_timer.cancel()

    timer = threading.Timer(LAST_RECORDING_KEEP_SECONDS, _clear_last_recording_audio)
    timer.daemon = True
    last_recording_clear_timer = timer
    timer.start()


def _store_last_recording_audio(audio_data: np.ndarray, total_frames: int, overrun: bool):
    """Cache the most recent audio so it can be re-transcribed."""
    global last_recording_audio, last_recording_overrun, last_recording_frames
    with recording_audio_lock:
        last_recording_audio = np.array(audio_data, dtype=np.float32, copy=True)
        last_recording_overrun = overrun
        last_recording_frames = total_frames
    _schedule_last_recording_clear()


def check_cuda_available() -> bool:
    """Check if CUDA is available"""
    # Simply return True effectively letting faster-whisper handle the check during load
    # This avoids importing the massive torch library just for a boolean check
    return True


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
    finally:
        gc.collect()


def _record_audio_worker(stop_event: threading.Event, samplerate: int = SAMPLE_RATE, channels: int = CHANNELS):
    """Background worker that records audio into memory buffers"""
    global audio_level, recording_total_frames, recording_overrun

    max_frames = MAX_RECORDING_FRAMES
    dropped_chunks = 0

    def callback(indata, frames, time_info, status):
        nonlocal dropped_chunks
        global audio_level, recording_total_frames, recording_overrun

        if status:
            logger.warning(f"Recording status: {status}")

        # Optimization: Simplified RMS or mean absolute for visualization
        # We don't need perfect RMS for a simple visualizer
        level = float(np.mean(np.abs(indata)))
        
        with audio_level_lock:
            # Simple decay smoothing could be done here if needed, but the GUI handles it
            audio_level = level

        chunk = np.array(indata, dtype=np.float32, copy=True)
        with recording_audio_lock:
            if recording_audio_chunks is not None:
                recording_audio_chunks.append(chunk)
                recording_total_frames += frames
                if recording_total_frames >= max_frames:
                    recording_overrun = True
                    stop_event.set()
            else:
                dropped_chunks += 1

    try:
        logger.info("Starting in-memory audio recording")
        # Optimization: Set explicit blocksize to reduce callback frequency
        # default is often ~26ms (40Hz), 2048 samples is ~128ms (8Hz) at 16k
        with sd.InputStream(samplerate=samplerate, channels=channels, callback=callback, blocksize=2048):
            while not stop_event.is_set():
                time.sleep(0.05)
        logger.info("Audio recording stopped")
        if dropped_chunks:
            logger.warning(f"Dropped {dropped_chunks} audio chunks while recording")
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
        
        # Free up memory explicitly after large transcription
        gc.collect()


@app.post("/record/start")
async def start_recording():
    """Start recording from default microphone"""
    global recording_thread, recording_stop_event, recording_start_time, audio_level

    if recording_thread is not None and recording_thread.is_alive():
        raise HTTPException(status_code=400, detail="Recording already in progress")

    # Starting a new session invalidates any cached audio
    _clear_last_recording_audio()
    _init_audio_buffer()

    # Reset audio level
    with audio_level_lock:
        audio_level = 0.0

    recording_stop_event = threading.Event()
    recording_thread = threading.Thread(
        target=_record_audio_worker,
        args=(recording_stop_event,),
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
    global recording_thread, recording_stop_event, recording_start_time, audio_level

    if recording_thread is None or recording_stop_event is None:
        raise HTTPException(status_code=400, detail="No recording in progress")

    _stop_recording_thread()
    audio_chunks, total_frames, overrun = _consume_audio_buffer()
    if not audio_chunks or total_frames == 0:
        raise HTTPException(status_code=500, detail="No audio data captured")

    if model is None:
        raise HTTPException(status_code=503, detail=model_load_error or "Model not loaded")

    duration = time.time() - recording_start_time if recording_start_time else 0.0
    recording_start_time = None

    try:
        try:
            audio_data = np.concatenate(audio_chunks, axis=0)
        except ValueError as concat_error:
            logger.error(f"Failed to combine audio chunks: {concat_error}")
            raise HTTPException(status_code=500, detail="Failed to combine audio data")

        if audio_data.ndim == 2 and audio_data.shape[1] == 1:
            audio_data = audio_data[:, 0]

        audio_data = audio_data.astype(np.float32, copy=False)

        if overrun:
            logger.warning("Recording hit max duration cap; truncating audio")

        logger.info(f"Transcribing recorded audio")
        segments, info = model.transcribe(
            audio_data,
            beam_size=5,
            language=None,
            task="transcribe",
        )

        transcription = " ".join([segment.text for segment in segments])

        # Cache the audio for potential re-run
        _store_last_recording_audio(audio_data, total_frames, overrun)

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
        gc.collect()


@app.post("/record/cancel")
async def cancel_recording():
    """Cancel an in-progress recording without transcribing"""
    global recording_start_time

    if recording_thread is None or recording_stop_event is None:
        logger.info("Cancel requested but no active recording")
        return {"status": "no_recording"}

    _stop_recording_thread()
    _clear_audio_buffer()
    _clear_last_recording_audio()
    recording_start_time = None

    logger.info("Recording cancelled and discarded")
    return {"status": "recording_cancelled"}


@app.post("/record/retranscribe")
async def retranscribe_cached_recording():
    """Re-run transcription on the most recent cached audio without re-recording."""
    if model is None:
        raise HTTPException(status_code=503, detail=model_load_error or "Model not loaded")

    with recording_audio_lock:
        cached_audio = None if last_recording_audio is None else np.array(last_recording_audio, copy=True)

    if cached_audio is None:
        raise HTTPException(status_code=404, detail="No cached recording available")

    try:
        logger.info("Retranscribing cached audio")
        segments, info = model.transcribe(
            cached_audio,
            beam_size=1,  # switch to sampling for variation
            temperature=[0.2, 0.5, 0.8],
            best_of=3,
            language=None,
            task="transcribe",
        )

        transcription = " ".join([segment.text for segment in segments])
        duration = info.duration if hasattr(info, "duration") else float(len(cached_audio) / SAMPLE_RATE)

        # Reset the expiry timer since the cache is actively used
        _schedule_last_recording_clear()

        return JSONResponse(
            {
                "text": transcription.strip(),
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": duration,
            }
        )
    except Exception as e:
        logger.error(f"Retranscription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Retranscription failed: {str(e)}")
    finally:
        gc.collect()


@app.post("/record/clear-cache")
async def clear_cached_recording():
    """Explicitly clear any cached post-transcription audio."""
    _clear_last_recording_audio()
    logger.info("Cached recording cleared on request")
    return {"status": "cache_cleared"}


@app.post("/shutdown")
async def shutdown():
    """Gracefully shutdown the server"""
    _clear_last_recording_audio()
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
