import re
import struct
import os

def normalize_text(text: str) -> str:
    """
    Normalize text for comparison:
    - Lowercase
    - Remove punctuation (apostrophes, quotes, commas, periods, etc.)
    - Collapse whitespace
    """
    # Remove apostrophes and quotes entirely (don't split words)
    text = re.sub(r"['\"`]", "", text)
    # Replace other punctuation with space to avoid merging words if they were comma-separated
    text = re.sub(r"[^\w\s]", " ", text)
    # Collapse whitespace
    return " ".join(text.lower().split())

def calculate_accuracy(reference: str, hypothesis: str) -> dict:
    """
    Calculate simple accuracy metrics between reference and hypothesis.
    Returns:
    {
        "match": bool (exact match after normalization),
        "ref_norm": normalized reference,
        "hyp_norm": normalized hypothesis
    }
    """
    ref_norm = normalize_text(reference)
    hyp_norm = normalize_text(hypothesis)
    
    return {
        "match": ref_norm == hyp_norm,
        "ref_norm": ref_norm,
        "hyp_norm": hyp_norm
    }

def read_wav_comment(path: str) -> str:
    """
    Read the ICMT (Comment) or ICNT chunk from a WAV file's LIST-INFO chunk.
    Returns the comment string or None if not found.
    """
    try:
        with open(path, "rb") as f:
            # RIFF header
            if f.read(4) != b"RIFF":
                return None
            f.read(4) # size
            if f.read(4) != b"WAVE":
                return None
            
            while True:
                chunk_id = f.read(4)
                if len(chunk_id) < 4:
                    break
                chunk_size = struct.unpack("<I", f.read(4))[0]
                
                # We are looking for the 'LIST' chunk
                if chunk_id == b"LIST":
                    list_type = f.read(4)
                    if list_type == b"INFO":
                        # Now parse sub-chunks
                        bytes_read = 4
                        while bytes_read < chunk_size:
                            sub_id = f.read(4)
                            sub_size = struct.unpack("<I", f.read(4))[0]
                            bytes_read += 8 + sub_size
                            
                            # Pad byte if size is odd
                            padded_size = sub_size + (sub_size % 2)
                            
                            content = f.read(padded_size)[:sub_size] # trim padding
                            
                            if sub_id in (b"ICMT", b"ICNT"):
                                try:
                                    return content.decode("utf-8").strip("\x00")
                                except:
                                    pass
                    else:
                        # Not an INFO list, skip
                        f.seek(chunk_size - 4, 1)
                else:
                    # Skip other chunks
                    f.seek(chunk_size, 1)
                    
    except Exception as e:
        print(f"Error reading WAV metadata: {e}")
        return None
    return None

def write_wav_comment(src_path: str, dest_path: str, comment: str):
    """
    Read a WAV file and write it to dest_path with an added/replaced ICMT chunk.
    Using a simple approach: Read all data, find LIST-INFO or create one.
    Actually, simpler: just use soundfile if possible, but soundfile doesn't expose chunks easily.
    We'll construct a new WAV file manually by copying the fmt and data chunks and adding a LIST chunk.
    """
    # ... This is complicated to do robustly without a library.
    # For the purpose of this task, we will just CREATE a new file 
    # using sounddevice/soundfile or just use the existing file and a separate metadata file?
    # No, user asked for "assumption that in the comment field... is the text".
    
    # Let's try to append a LIST chunk if it doesn't exist?
    # Or just use `ffmpeg` if valid.
    # But I can write a simple RIFF writer for this specific purpose (Testing only).
    
    # Minimal WAV writer that copies data from src
    import wave
    
    # But 'wave' doesn't support LIST chunks.
    
    # Let's just create the file using a custom script that is brute force.
    # We will assume input is simple (RIFF + fmt + data).
    pass
