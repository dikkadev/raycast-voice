import sys
import os
import time
import subprocess
import statistics
import urllib.request
import urllib.parse
import json

# Add backend dir to path for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import test_utils

# Configuration
SERVER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcription_server.py")
PYTHON_EXE = sys.executable 
VENV_PYTHON = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "Scripts", "python.exe")
if os.path.exists(VENV_PYTHON):
    PYTHON_EXE = VENV_PYTHON

TEST_AUDIO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "45seconds_text_in_comment.wav")
SERVER_URL = "http://127.0.0.1:51234"
WARMUP_ITERATIONS = 5

def kill_existing_server():
    try:
        req = urllib.request.Request(f"{SERVER_URL}/shutdown", method="POST")
        with urllib.request.urlopen(req, timeout=1) as f:
            pass
        time.sleep(1)
    except:
        pass

def wait_for_server():
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"{SERVER_URL}/health", timeout=1) as f:
                data = json.loads(f.read().decode('utf-8'))
                if f.status == 200 and data.get("status") == "healthy":
                    return True
        except:
            time.sleep(0.5)
    return False

def run_benchmark_iteration(warmup_enabled: bool, iteration_id: int, expected_text: str):
    print(f"--- Iteration {iteration_id} (Warmup: {warmup_enabled}) ---")
    
    cmd = [PYTHON_EXE, SERVER_SCRIPT, "--port", "51234"]
    if not warmup_enabled:
        cmd.append("--no-warmup")
        
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    
    try:
        if not wait_for_server():
            print("Server failed to start")
            return None

        # 2. Measure First Transcription Time
        start_time = time.time()
        
        boundary = '----WeiboBoundary7863'
        with open(TEST_AUDIO, "rb") as f:
            file_content = f.read()
            
        lines = []
        lines.append(f'--{boundary}'.encode('utf-8'))
        lines.append(f'Content-Disposition: form-data; name="file"; filename="test.wav"'.encode('utf-8'))
        lines.append(f'Content-Type: audio/wav'.encode('utf-8'))
        lines.append(b'')
        lines.append(file_content)
        lines.append(f'--{boundary}--'.encode('utf-8'))
        lines.append(b'')
        
        body = b'\r\n'.join(lines)
        
        req = urllib.request.Request(f"{SERVER_URL}/transcribe", data=body, method="POST")
        req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
        
        resp_data = None
        try:
            with urllib.request.urlopen(req, timeout=30) as f:
                if f.status != 200:
                    print(f"Transcription failed: {f.status}")
                    return None
                resp_data = json.loads(f.read().decode("utf-8"))
        except Exception as e:
            print(f"Request failed: {e}")
            return None
            
        end_time = time.time()
        duration = end_time - start_time
        
        # Check Accuracy
        result_text = resp_data.get("text", "")
        acc = test_utils.calculate_accuracy(expected_text, result_text)
        
        print(f"Time: {duration:.4f}s | Match: {acc['match']}")
        if not acc['match']:
            # Truncate for log readability if too long
            print(f"  Exp (norm): '{acc['ref_norm'][:100]}...'")
            print(f"  Got (norm): '{acc['hyp_norm'][:100]}...'")
        
        return duration
        
    finally:
        try:
            req = urllib.request.Request(f"{SERVER_URL}/shutdown", method="POST")
            with urllib.request.urlopen(req, timeout=1) as f:
                pass
        except:
            proc.terminate()
        proc.wait()

def main():
    if not os.path.exists(TEST_AUDIO):
        print(f"Test audio not found: {TEST_AUDIO}")
        return
        
    # Read Expected Text from Metadata
    expected_text = test_utils.read_wav_comment(TEST_AUDIO)
    if not expected_text:
        print(f"WARNING: No metadata found in {TEST_AUDIO}. Using empty string as reference.")
        expected_text = ""
    else:
        print(f"Expected Text (from metadata): '{expected_text[:50]}...'")

    print("\nKilling any existing server...")
    kill_existing_server()
    time.sleep(2) 

    results_warmup = []
    results_no_warmup = []

    print(f"\nBenchmark Plans:")
    print(f"1. Run {WARMUP_ITERATIONS} times WITH warmup")
    print(f"2. Run {WARMUP_ITERATIONS} times WITHOUT warmup")
    print(f"Expected: '{expected_text[:50]}...'")

    print("\n=== Benchmarking WITH Warmup ===")
    for i in range(WARMUP_ITERATIONS):
        dur = run_benchmark_iteration(True, i+1, expected_text)
        if dur: results_warmup.append(dur)
        time.sleep(1)

    print("\n=== Benchmarking WITHOUT Warmup ===")
    for i in range(WARMUP_ITERATIONS):
        dur = run_benchmark_iteration(False, i+1, expected_text)
        if dur: results_no_warmup.append(dur)
        time.sleep(1)

    print("\n\n=== RESULTS ===")
    
    if results_warmup:
        avg_w = statistics.mean(results_warmup)
        print(f"With Warmup:    Avg: {avg_w:.4f}s  Min: {min(results_warmup):.4f}s  Max: {max(results_warmup):.4f}s")
    
    if results_no_warmup:
        avg_nw = statistics.mean(results_no_warmup)
        print(f"Without Warmup: Avg: {avg_nw:.4f}s  Min: {min(results_no_warmup):.4f}s  Max: {max(results_no_warmup):.4f}s")

    if results_warmup and results_no_warmup:
        diff = avg_nw - avg_w
        speedup = avg_nw / avg_w if avg_w > 0 else 0
        print(f"\nImprovement: {diff:.4f}s reduction ({speedup:.2f}x speedup)")

if __name__ == "__main__":
    main()
