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
        audio_path = Path(__file__).parent / "testdata" / "45seconds_text_in_comment.wav"

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

    # Run multiple iterations for benchmarking
    ITERATIONS = 5
    latencies = []
    import time
    import statistics

    print(f"\nRunning {ITERATIONS} iterations...")

    final_text = ""
    final_info = None

    for i in range(ITERATIONS):
        start = time.perf_counter()
        segments, info = model.transcribe(
            str(audio_path),
            beam_size=5,
            language=None,
            task="transcribe",
        )
        # Materialize the generator to ensure processing completes
        text = " ".join(segment.text for segment in segments).strip()
        end = time.perf_counter()
        
        duration = end - start
        latencies.append(duration)
        print(f"  Iteration {i+1}: {duration:.4f}s")
        
        # Keep the last result for display
        final_text = text
        final_info = info

    avg_latency = statistics.mean(latencies)
    min_latency = min(latencies)
    max_latency = max(latencies)

    print("\n=== Benchmarking Results ===")
    print(f"Iterations: {ITERATIONS}")
    print(f"Average: {avg_latency:.4f}s")
    print(f"Min:     {min_latency:.4f}s")
    print(f"Max:     {max_latency:.4f}s")

    print("\n=== Transcription Result (Last Run) ===\n")
    print(final_text or "<empty>")
    print("\n=== Meta ===")
    print(f"Language: {final_info.language} (p={final_info.language_probability:.2f})")
    print(f"Duration: {getattr(final_info, 'duration', 0):.2f}s")
    
    # Check against metadata
    import test_utils
    expected_text = test_utils.read_wav_comment(str(audio_path))
    if expected_text:
        print("\n=== Accuracy ===")
        print(f"Expected: {expected_text}")
        acc = test_utils.calculate_accuracy(expected_text, final_text)
        print(f"Match: {acc['match']}")
        if not acc['match']:
            print(f"  Exp Clean: {acc['ref_norm']}")
            print(f"  Got Clean: {acc['hyp_norm']}")
    else:
        print("\n=== Accuracy ===")
        print("No expected text found in WAV metadata (ICMT chunk).")

if __name__ == "__main__":
    main()


