const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

const { analyzeTranscript } = require('./scripts/analyze');
const { cutClip } = require('./scripts/clipper');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const CLIPS_DIR = path.join(__dirname, 'clips');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
[DOWNLOAD_DIR, CLIPS_DIR, TRANSCRIPTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Path to cookies.txt (Netscape format), placed at project root.
// Used to avoid YouTube's bot-detection when running on a datacenter IP (like Render).
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
function getCookiesArgs() {
  if (fs.existsSync(COOKIES_FILE)) {
    return ['--cookies', COOKIES_FILE];
  }
  return [];
}

app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static(DOWNLOAD_DIR));
app.use('/clips', express.static(CLIPS_DIR));

// WebSocket — same pattern as noxload: client registers a jobId, server pushes progress
const jobs = new Map();
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try { const { jobId } = JSON.parse(msg); jobs.set(jobId, ws); } catch {}
  });
  ws.on('close', () => { for (const [k, v] of jobs) if (v === ws) jobs.delete(k); });
});
function send(jobId, data) {
  const ws = jobs.get(jobId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

// yt-dlp path
function getYtDlp() {
  const paths = [
    'D:\\Python\\Scripts\\yt-dlp.exe',
    'yt-dlp',
    'D:\\Python\\Scripts\\yt-dlp',
    'C:\\Python312\\Scripts\\yt-dlp.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs\\Python\\Python312\\Scripts\\yt-dlp.exe'),
  ];
  for (const p of paths) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore' }); return p; } catch {}
  }
  return null;
}

// ffmpeg path
function getFfmpeg() {
  const paths = [
    'C:\\Users\\DELL\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const p of paths) {
    try {
      execSync(`"${p}" -version`, { stdio: 'ignore' });
      if (!p.includes('/') && !p.includes('\\')) {
        try {
          const resolved = execSync(`which ${p}`).toString().trim();
          if (resolved) return resolved;
        } catch {}
      }
      return p;
    } catch {}
  }
  return null;
}

// python3 path (for faster-whisper transcribe.py)
function getPython() {
  const paths = ['python3', 'python'];
  for (const p of paths) {
    try { execSync(`${p} --version`, { stdio: 'ignore' }); return p; } catch {}
  }
  return null;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 80) || String(Date.now());
}

// ---------- ORIGINAL NOXLOAD ROUTES (unchanged) ----------

app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL.' });

  const ytdlp = getYtDlp();
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not found.' });

  const cookieArgs = getCookiesArgs();
  const cookieFlag = cookieArgs.length ? `${cookieArgs[0]} "${cookieArgs[1]}"` : '';

  exec(`"${ytdlp}" --dump-json --no-playlist --remote-components ejs:github ${cookieFlag} "${url}"`, { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp info error:', stderr || err.message);
      return res.status(500).json({ error: 'Could not fetch video info. Check the URL.' });
    }
    try {
      const info = JSON.parse(stdout);
      const ffmpeg = getFfmpeg();

      const heights = new Set();
      (info.formats || []).forEach(f => { if (f.height) heights.add(f.height); });

      const allQ = [2160, 1440, 1080, 720, 480, 360, 240, 144];
      const available = allQ.filter(h => [...heights].some(fh => fh >= h));

      const formats = [];
      available.forEach(h => {
        let label, badge = null;
        if (h === 2160) { label = '4K Ultra HD'; badge = '4K'; }
        else if (h === 1440) { label = '1440p QHD'; badge = 'QHD'; }
        else if (h === 1080) { label = '1080p Full HD'; badge = 'FHD'; }
        else if (h === 720) { label = '720p HD'; badge = 'HD'; }
        else if (h === 480) { label = '480p SD'; }
        else if (h === 360) { label = '360p'; }
        else if (h === 240) { label = '240p'; }
        else if (h === 144) { label = '144p'; badge = 'FAST'; }

        const needsMerge = h >= 720;
        formats.push({
          id: ffmpeg
            ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
            : `best[height<=${h}]`,
          label, badge,
          desc: `MP4 · ${h}p`,
          icon: h >= 1440 ? '🎬' : h >= 720 ? '📺' : '📱',
          ext: 'mp4', height: h,
          needsFfmpeg: needsMerge && !ffmpeg
        });
      });

      formats.push({ id: 'bestaudio/best', label: 'Audio Only', desc: 'MP3 · music & podcasts', icon: '🎵', ext: 'mp3', badge: null, height: 0, needsFfmpeg: false });

      const fmt = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0);

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || `${Math.floor((info.duration||0)/60)}:${String((info.duration||0)%60).padStart(2,'0')}`,
        uploader: info.uploader,
        platform: info.extractor_key,
        viewCount: info.view_count ? fmt(info.view_count) : null,
        likeCount: info.like_count ? fmt(info.like_count) : null,
        uploadDate: info.upload_date ? info.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1') : null,
        hasFfmpeg: !!ffmpeg,
        duration_seconds: info.duration || 0,
        formats
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info.' });
    }
  });
});

app.post('/api/download', (req, res) => {
  const { url, formatId, ext, jobId, title } = req.body;
  if (!url) return res.status(400).json({ error: 'Invalid URL.' });

  const ytdlp = getYtDlp();
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not found.' });

  const ffmpeg = getFfmpeg();
  const safeName = title ? sanitizeFilename(title) : String(Date.now());
  const outputTemplate = path.join(DOWNLOAD_DIR, `${safeName}.%(ext)s`);
  const cookieArgs = getCookiesArgs();

  try {
    fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.startsWith(safeName))
      .forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f)));
  } catch (e) {}

  let args;
  if (ext === 'mp3') {
    args = ['-x', '--audio-format', 'mp3', '--force-overwrites', '--no-playlist', '--newline', '--remote-components', 'ejs:github', ...cookieArgs, '-o', outputTemplate];
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  } else if (ffmpeg) {
    args = ['-f', formatId, '--merge-output-format', 'mp4', '--force-overwrites', '--ffmpeg-location', ffmpeg, '--no-playlist', '--newline', '--remote-components', 'ejs:github', ...cookieArgs, '-o', outputTemplate];
  } else {
    args = ['-f', formatId, '--force-overwrites', '--no-playlist', '--newline', '--remote-components', 'ejs:github', ...cookieArgs, '-o', outputTemplate];
  }
  args.push(url);

  const proc = spawn(ytdlp, args);
  let stderrBuf = '';

  proc.stdout.on('data', (data) => {
    const line = data.toString();
    const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\S+\/s)/);
    if (m) send(jobId, { type: 'progress', percent: parseFloat(m[1]), speed: m[2], msg: `Downloading... ${m[2]}` });
    if (line.includes('Merging')) send(jobId, { type: 'progress', percent: 95, speed: '', msg: 'Merging video & audio...' });
    if (line.includes('Deleting')) send(jobId, { type: 'progress', percent: 98, speed: '', msg: 'Finalizing...' });
  });

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp download error:', stderrBuf);
      send(jobId, { type: 'error' });
      return res.status(500).json({ error: 'Download failed.' });
    }

    let files = [];
    try {
      files = fs.readdirSync(DOWNLOAD_DIR)
        .filter(f => f.startsWith(safeName))
        .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime }))
        .sort((a, b) => b.time - a.time);
    } catch(e) {}

    if (!files.length) return res.status(500).json({ error: 'File not found after download.' });

    const stat = fs.statSync(path.join(DOWNLOAD_DIR, files[0].name));
    send(jobId, { type: 'done' });
    res.json({
      success: true,
      filename: files[0].name,
      downloadUrl: `/downloads/${encodeURIComponent(files[0].name)}`,
      sizeMB: (stat.size / (1024*1024)).toFixed(2)
    });
  });
});

app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(DOWNLOAD_DIR, f));
      return { name: f, size: (stat.size/(1024*1024)).toFixed(2)+' MB', date: stat.mtime.toLocaleString(), url: `/downloads/${encodeURIComponent(f)}` };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(files);
});

app.delete('/api/files/:name', (req, res) => {
  const fp = path.join(DOWNLOAD_DIR, req.params.name);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); res.json({ success: true }); }
  else res.status(404).json({ error: 'Not found.' });
});

// ---------- NEW: SHORTS CLIPPER PIPELINE ----------

app.post('/api/generate-shorts', async (req, res) => {
  const { url, jobId } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL.' });

  const ytdlp = getYtDlp();
  const ffmpeg = getFfmpeg();
  const python = getPython();
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not found.' });
  if (!ffmpeg) return res.status(500).json({ error: 'ffmpeg not found.' });
  if (!python) return res.status(500).json({ error: 'python3 not found.' });

  // Respond immediately; do the real work async and push progress over WebSocket.
  res.json({ success: true, jobId, msg: 'Job started.' });

  const safeName = sanitizeFilename(`shorts_${Date.now()}`);
  const sourceVideo = path.join(DOWNLOAD_DIR, `${safeName}.mp4`);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${safeName}.json`);
  const cookieArgs = getCookiesArgs();

  try {
    // 1. Download source video (720p is plenty for Shorts crops, keeps it fast/cheap)
    send(jobId, { type: 'progress', stage: 'download', percent: 5, msg: 'Downloading video...' });
    await new Promise((resolve, reject) => {
      const args = [
        '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]',
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpeg,
        '--no-playlist', '--newline',
        '--remote-components', 'ejs:github',
        ...cookieArgs,
        '-o', sourceVideo,
        url
      ];
      const proc = spawn(ytdlp, args);
      let stderrBuf = '';
      proc.stdout.on('data', d => {
        const line = d.toString();
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) send(jobId, { type: 'progress', stage: 'download', percent: 5 + parseFloat(m[1]) * 0.25, msg: `Downloading... ${m[1]}%` });
      });
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp failed: ${stderrBuf.slice(-500)}`)));
    });

    // 2. Transcribe with faster-whisper
    send(jobId, { type: 'progress', stage: 'transcribe', percent: 35, msg: 'Transcribing audio...' });
    await new Promise((resolve, reject) => {
      const proc = spawn(python, [path.join(__dirname, 'scripts', 'transcribe.py'), sourceVideo, transcriptPath, 'base']);
      let stderrBuf = '';
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Whisper failed: ${stderrBuf.slice(-500)}`)));
    });

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));

    // 3. LLM analysis — find 5 best moments
    send(jobId, { type: 'progress', stage: 'analyze', percent: 55, msg: 'Finding best moments...' });
    const { provider, clips } = await analyzeTranscript(transcript.segments, transcript.duration);
    send(jobId, { type: 'progress', stage: 'analyze', percent: 65, msg: `Found ${clips.length} moments (via ${provider})` });

    // 4. Cut + crop + caption each clip
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const pct = 65 + Math.round((i / clips.length) * 30);
      send(jobId, { type: 'progress', stage: 'cutting', percent: pct, msg: `Cutting clip ${i + 1}/${clips.length}: ${clip.title}` });

      const outputPath = path.join(CLIPS_DIR, `${safeName}_clip${i + 1}.mp4`);
      try {
        await cutClip({
          ffmpegPath: ffmpeg,
          sourceVideo,
          start: clip.start,
          end: clip.end,
          transcriptSegments: transcript.segments,
          outputPath,
          tmpDir: CLIPS_DIR
        });
        results.push({
          ...clip,
          filename: path.basename(outputPath),
          url: `/clips/${encodeURIComponent(path.basename(outputPath))}`
        });
      } catch (clipErr) {
        console.error(`Clip ${i + 1} failed:`, clipErr.message);
        // Skip this clip but keep going with the rest
      }
    }

    send(jobId, { type: 'done', clips: results });
  } catch (err) {
    console.error('generate-shorts pipeline error:', err.message);
    send(jobId, { type: 'error', msg: err.message });
  } finally {
    // Clean up the big source video + raw transcript to save disk space
    try { fs.unlinkSync(sourceVideo); } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`\n⚡ Server running at http://localhost:${PORT}`);
  console.log(`📁 Downloads: ${DOWNLOAD_DIR}`);
  console.log(`✂️  Clips: ${CLIPS_DIR}`);
  console.log(`🔧 FFmpeg: ${getFfmpeg() || 'NOT FOUND'}`);
  console.log(`🐍 yt-dlp: ${getYtDlp() || 'NOT FOUND'}`);
  console.log(`🐍 python3: ${getPython() || 'NOT FOUND'}`);
  console.log(`🍪 Cookies: ${fs.existsSync(COOKIES_FILE) ? 'loaded' : 'NOT FOUND (may hit YouTube bot-detection)'}`);
  console.log(`🔑 Groq key: ${process.env.GROQ_API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`🔑 Gemini key: ${process.env.GEMINI_API_KEY ? 'set' : 'NOT SET'}\n`);
});
