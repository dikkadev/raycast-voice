"""
Simple CLI tool to test the Whisper backend independently of Raycast.

Usage:
  uv run python test_transcription.py              # uses default testdata file
  uv run python test_transcription.py path/to.wav # custom file
"""

import sys
import os
import logging
from pathlib import Path

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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main() -> None:
    # Resolve audio path
    if len(sys.argv) > 1:
        audio_path = Path(sys.argv[1])
    else:
        audio_path = Path(__file__).parent / "testdata" / "hello_test_1_2_3.wav"

    if not audio_path.is_file():
        print(f"Audio file not found: {audio_path}")
        sys.exit(1)

    # Mirror server config
    model_size = os.environ.get("WHISPER_MODEL", "base")
    device = os.environ.get("WHISPER_DEVICE", "cuda")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")

    logger.info("Loading Whisper model '%s' on %s (%s)", model_size, device, compute_type)

    model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute_type,
    )

    logger.info("Transcribing file: %s", audio_path)

    segments, info = model.transcribe(
        str(audio_path),
        beam_size=5,
        language=None,
        task="transcribe",
    )

    text = " ".join(segment.text for segment in segments).strip()

    print("\n=== Transcription Result ===\n")
    print(text or "<empty>")
    print("\n=== Meta ===")
    print(f"Language: {info.language} (p={info.language_probability:.2f})")
    print(f"Duration: {getattr(info, 'duration', 0):.2f}s")


if __name__ == "__main__":
    main()


