#!/usr/bin/env python3
"""
Usage: python3 transcribe.py <input_video_path> <output_json_path> [model_size] [chunk_seconds]

Transcribes with faster-whisper, but splits the source into fixed-length
audio chunks first (default 15 min) and transcribes them one at a time.

Why: faster-whisper decodes the WHOLE input into a float32 PCM buffer in
memory before processing. At 16kHz mono that's ~230MB of RAM for a 60-minute
video — enough by itself to blow past Render's free-tier 512MB limit.
Chunking caps peak memory at roughly (chunk_seconds * 64KB/s), regardless of
how long the source video is, so a 90-minute video costs the same peak RAM
as a 15-minute one.

Each chunk's audio is extracted with ffmpeg into a small temp .wav, that .wav
is transcribed, timestamps are offset by the chunk's start time, and the .wav
is deleted before moving to the next chunk. The whisper model itself is
loaded once and reused across chunks (model loading is the slow part —
no need to pay that cost per chunk).
"""
import sys
import os
import json
import subprocess
import tempfile
from faster_whisper import WhisperModel

CHUNK_SECONDS_DEFAULT = 900  # 15 minutes

def get_duration(path):
    """ffprobe the container duration in seconds (float)."""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', path],
        capture_output=True, text=True, check=True
    )
    return float(out.stdout.strip())

def extract_chunk_audio(source_path, start, duration, out_wav):
    """Extract [start, start+duration) as 16kHz mono PCM wav — small, cheap to hold in RAM."""
    subprocess.run(
        ['ffmpeg', '-y', '-ss', str(start), '-i', source_path, '-t', str(duration),
         '-ar', '16000', '-ac', '1', '-vn', out_wav],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True
    )

def main():
    if len(sys.argv) < 3:
        print("Usage: transcribe.py <input> <output_json> [model_size] [chunk_seconds]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "tiny"
    chunk_seconds = int(sys.argv[4]) if len(sys.argv) > 4 else CHUNK_SECONDS_DEFAULT

    total_duration = get_duration(input_path)

    # cpu_threads=1 keeps per-thread buffer overhead low and predictable —
    # important on a shared 0.1 CPU / 512MB free-tier instance.
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=1)

    all_segments = []
    detected_language = None

    chunk_start = 0.0
    tmp_dir = tempfile.mkdtemp(prefix="whisper_chunks_")

    try:
        while chunk_start < total_duration:
            this_chunk_len = min(chunk_seconds, total_duration - chunk_start)
            chunk_wav = os.path.join(tmp_dir, "chunk.wav")

            extract_chunk_audio(input_path, chunk_start, this_chunk_len, chunk_wav)

            segments, info = model.transcribe(chunk_wav, beam_size=1, vad_filter=True)
            if detected_language is None:
                detected_language = info.language

            for seg in segments:
                all_segments.append({
                    "start": round(chunk_start + seg.start, 2),
                    "end": round(chunk_start + seg.end, 2),
                    "text": seg.text.strip()
                })

            # Free the chunk file immediately — don't let temp audio pile up
            try:
                os.remove(chunk_wav)
            except OSError:
                pass

            print(f"Chunk {chunk_start:.0f}s-{chunk_start + this_chunk_len:.0f}s done "
                  f"({len(all_segments)} segments so far)", file=sys.stderr)

            chunk_start += chunk_seconds
    finally:
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    result = {
        "language": detected_language,
        "duration": total_duration,
        "segments": all_segments
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Transcribed {len(result['segments'])} segments across "
          f"{int(total_duration // chunk_seconds) + 1} chunks -> {output_path}")

if __name__ == "__main__":
    main()
