import subprocess
import os

full_text = "Have you ever wondered how difficult it is for technology to interpret human speech? It is a fascinating process that turns invisible sound waves into digital text. Imagine standing in a busy coffee shop in Berlin. The background clatter of porcelain cups and low murmurs make it hard to hear, yet our brains filter the noise effortlessly. Machines are slowly learning to do the same thing. However, they still struggle to differentiate between words like 'right', 'write', and 'wright' without context clues. When you speak clearly, at a moderate pace, you help the software bridge that gap. So, take a deep breath, enunciate your vowels, and let’s see if every syllable is captured correctly. This is the end of the narrative sample."

input_file = "testdata/45seconds_text_in_comment.wav"
output_file = "testdata/45seconds_fixed.wav"

cmd = [
    "ffmpeg",
    "-y",
    "-i", input_file,
    "-metadata", f"comment={full_text}",
    "-c", "copy",
    output_file
]

print(f"Running: {' '.join(cmd)}")
subprocess.check_call(cmd)

print("Replacing original file...")
os.replace(output_file, input_file)
print("Done.")
