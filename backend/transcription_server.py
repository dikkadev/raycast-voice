"""
Whisper Transcription Server with CUDA Support
Provides HTTP API for audio transcription using faster-whisper
"""

import os
import logging
from pathlib import Path
from typing import Optional
import tempfile

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# On Windows, we must explicitly add the NVIDIA libraries to the DLL search path
if os.name == 'nt':
    # Check for NVIDIA CUDNN DLLs in Program Files
    cudnn_base = r"C:\Program Files\NVIDIA\CUDNN\v9.16\bin"
    if os.path.exists(cudnn_base):
        # Check common CUDA version directories (12.9, 13.0, 12.8, 12.7, etc.)
        cuda_versions = ["13.0", "12.9", "12.8", "12.7", "12.6", "12.5", "12.4", "12.3", "12.2", "12.1", "12.0"]
        for cuda_version in cuda_versions:
            cudnn_path = os.path.join(cudnn_base, cuda_version)
            if os.path.exists(cudnn_path):
                os.add_dll_directory(cudnn_path)  # Python 3.8+ DLL loading
                os.environ["PATH"] = cudnn_path + os.pathsep + os.environ["PATH"]  # Fallback

from faster_whisper import WhisperModel

import sounddevice as sd
import soundfile as sf
import threading
import queue
import time

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Server configuration
HOST = os.environ.get("WHISPER_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_SERVER_PORT", "51234"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")  # tiny, base, small, medium, large
DEVICE = "cuda"  # Use CUDA
COMPUTE_TYPE = "float16"  # Use float16 for CUDA

app = FastAPI(title="Whisper Transcription Server")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model and recording state
model: Optional[WhisperModel] = None

recording_thread: Optional[threading.Thread] = None
recording_stop_event: Optional[threading.Event] = None
recording_file_path: Optional[str] = None
recording_start_time: Optional[float] = None
last_transcription_result: Optional[dict] = None


def load_model():
    """Load the Whisper model with CUDA support"""
    global model
    if model is None:
        logger.info(f"Loading Whisper model: {MODEL_SIZE} on {DEVICE} with {COMPUTE_TYPE}")
        try:
            model = WhisperModel(
                MODEL_SIZE,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root=None,  # Use default cache directory
            )
            logger.info("Model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise


def _record_audio_worker(file_path: str, stop_event: threading.Event, samplerate: int = 16000, channels: int = 1):
    """
    Background worker that records from default microphone to a WAV file
    until stop_event is set.
    """
    q: "queue.Queue[bytes]" = queue.Queue()

    def callback(indata, frames, time_info, status):
        if status:
            logger.warning(f"Recording status: {status}")
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
    logger.info(f"Server listening on {HOST}:{PORT}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "model_loaded": model is not None,
        "recording": recording_thread is not None and recording_thread.is_alive(),
    }


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe audio file uploaded by client.
    This endpoint is kept for compatibility but the preferred flow for Raycast
    is to use /record/start and /record/stop to let the backend handle capture.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    temp_file = None
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_path = temp_file.name

        logger.info(f"Transcribing uploaded audio file: {file.filename} ({len(content)} bytes)")

        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            language=None,
            task="transcribe",
        )

        transcription = " ".join([segment.text for segment in segments])

        logger.info(f"Transcription completed: {len(transcription)} characters")
        logger.info(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")

        return JSONResponse(
            {
                "text": transcription.strip(),
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
            }
        )

    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    finally:
        if temp_file and temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except Exception as e:
                logger.warning(f"Failed to delete temporary file: {e}")


@app.post("/record/start")
async def start_recording():
    """
    Start recording from the default microphone on the backend.
    """
    global recording_thread, recording_stop_event, recording_file_path, recording_start_time

    if recording_thread is not None and recording_thread.is_alive():
        raise HTTPException(status_code=400, detail="Recording already in progress")

    # Create temp WAV file for recording
    temp_dir = tempfile.gettempdir()
    recording_file_path = os.path.join(temp_dir, "whisper_recording.wav")

    # Ensure old file is removed
    try:
        if os.path.exists(recording_file_path):
            os.unlink(recording_file_path)
    except Exception:
        pass

    recording_stop_event = threading.Event()
    recording_thread = threading.Thread(
        target=_record_audio_worker,
        args=(recording_file_path, recording_stop_event),
        daemon=True,
    )
    recording_start_time = time.time()
    recording_thread.start()

    logger.info(f"Recording started: {recording_file_path}")
    return {"status": "recording_started"}


@app.post("/record/stop")
async def stop_recording_and_transcribe():
    """
    Stop recording and transcribe the recorded audio.
    """
    global recording_thread, recording_stop_event, recording_file_path, recording_start_time, last_transcription_result

    if recording_thread is None or recording_stop_event is None or recording_file_path is None:
        raise HTTPException(status_code=400, detail="No recording in progress")

    # Signal recording thread to stop
    recording_stop_event.set()
    recording_thread.join(timeout=5.0)

    # Reset recording state
    recording_thread = None
    recording_stop_event = None

    if not os.path.exists(recording_file_path):
        raise HTTPException(status_code=500, detail="Recorded file not found")

    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Estimate duration if not available elsewhere
    duration = 0.0
    if recording_start_time is not None:
        duration = time.time() - recording_start_time
    recording_start_time = None

    try:
        logger.info(f"Transcribing recorded file: {recording_file_path}")
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
        last_transcription_result = result

        logger.info(f"Transcription completed from recording: {len(transcription)} characters")
        logger.info(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")

        return JSONResponse(result)
    except Exception as e:
        logger.error(f"Transcription failed for recorded audio: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        try:
            if os.path.exists(recording_file_path):
                os.unlink(recording_file_path)
        except Exception as e:
            logger.warning(f"Failed to delete recorded file: {e}")


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "name": "Whisper Transcription Server",
        "version": "0.1.0",
        "endpoints": {
            "health": "/health",
            "transcribe": "/transcribe (POST)",
            "record_start": "/record/start (POST)",
            "record_stop": "/record/stop (POST)",
        }
    }


if __name__ == "__main__":
    import uvicorn
    
    logger.info(f"Starting Whisper Transcription Server on {HOST}:{PORT}")
    logger.info(f"Model: {MODEL_SIZE}, Device: {DEVICE}, Compute Type: {COMPUTE_TYPE}")
    
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info"
    )
