#!/usr/bin/env python3
"""
Usage: python3 transcribe.py <input_video_or_audio_path> <output_json_path>

Transcribes with faster-whisper and writes segment-level timestamps
(start, end, text) as JSON. Model size defaults to "base" for speed on
free-tier CPU — bump to "small" if you have more compute and want better
accuracy.
"""
import sys
import json
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 3:
        print("Usage: transcribe.py <input> <output_json>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "base"

    # CPU + int8 = works on free-tier machines without a GPU
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    segments, info = model.transcribe(input_path, beam_size=5, vad_filter=True)

    result = {
        "language": info.language,
        "duration": info.duration,
        "segments": []
    }

    for seg in segments:
        result["segments"].append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip()
        })

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Transcribed {len(result['segments'])} segments -> {output_path}")

if __name__ == "__main__":
    main()
