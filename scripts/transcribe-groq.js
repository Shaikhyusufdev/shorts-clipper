const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 15-min chunks: keeps each upload well under Groq's file-size limit and
// keeps ffmpeg's own extraction step cheap regardless of total video length.
const CHUNK_SECONDS = 900;
const GROQ_MODEL = 'whisper-large-v3-turbo'; // fast + strong multilingual (incl. Hindi/Hinglish) accuracy

function getDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', inputPath
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(`ffprobe failed: ${err.slice(-300)}`)));
  });
}

// Extract a chunk as a small compressed mp3 (not raw wav) — a 15-min chunk
// at 64kbps mono is ~7MB, comfortably under Groq's upload limit, versus
// ~28MB for the equivalent raw PCM wav.
function extractChunkAudio(sourcePath, start, duration, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-ss', String(start), '-i', sourcePath, '-t', String(duration),
      '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', outPath
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg chunk extract failed: ${stderr.slice(-500)}`)));
  });
}

async function transcribeChunk(chunkPath) {
  const fileBuffer = fs.readFileSync(chunkPath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }), path.basename(chunkPath));
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq transcription failed (${res.status})`);
  return data;
}

/**
 * Transcribes a video file by chunking its audio and sending each chunk to
 * Groq's hosted Whisper API. Runs entirely off-CPU (Groq's hardware does the
 * work), so it doesn't compete with Render's free-tier 0.1 CPU / 512MB limit
 * the way local faster-whisper did — and it's far more accurate, especially
 * on Hindi/Hinglish/mixed-language audio.
 */
async function transcribeVideo(sourcePath, outputJsonPath, onProgress) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set — required for transcription.');
  }

  const totalDuration = await getDuration(sourcePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq_chunks_'));
  const allSegments = [];
  let detectedLanguage = null;

  try {
    let chunkStart = 0;
    while (chunkStart < totalDuration) {
      const thisLen = Math.min(CHUNK_SECONDS, totalDuration - chunkStart);
      const chunkPath = path.join(tmpDir, 'chunk.mp3');

      await extractChunkAudio(sourcePath, chunkStart, thisLen, chunkPath);
      const result = await transcribeChunk(chunkPath);
      if (detectedLanguage === null) detectedLanguage = result.language;

      (result.segments || []).forEach(seg => {
        allSegments.push({
          start: Math.round((chunkStart + seg.start) * 100) / 100,
          end: Math.round((chunkStart + seg.end) * 100) / 100,
          text: (seg.text || '').trim()
        });
      });

      try { fs.unlinkSync(chunkPath); } catch {}
      if (onProgress) onProgress(chunkStart + thisLen, totalDuration);
      chunkStart += CHUNK_SECONDS;
    }
  } finally {
    try { fs.rmdirSync(tmpDir); } catch {}
  }

  const result = { language: detectedLanguage, duration: totalDuration, segments: allSegments };
  fs.writeFileSync(outputJsonPath, JSON.stringify(result, null, 2), 'utf-8');
  return result;
}

module.exports = { transcribeVideo };
