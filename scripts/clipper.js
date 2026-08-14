const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Converts seconds -> SRT timestamp "00:00:12,500"
function toSrtTime(seconds) {
  const ms = Math.round((seconds % 1) * 1000);
  const totalSec = Math.floor(seconds);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms).padStart(3, '0')}`;
}

// Builds an .srt file for just the segments inside [clipStart, clipEnd],
// with timestamps re-based to 0 (relative to the clip, not the source video).
function writeSrtForClip(transcriptSegments, clipStart, clipEnd, srtPath) {
  const relevant = transcriptSegments.filter(
    s => s.end > clipStart && s.start < clipEnd
  );

  const lines = relevant.map((seg, i) => {
    const relStart = Math.max(0, seg.start - clipStart);
    const relEnd = Math.min(clipEnd - clipStart, seg.end - clipStart);
    return `${i + 1}\n${toSrtTime(relStart)} --> ${toSrtTime(relEnd)}\n${seg.text}\n`;
  });

  fs.writeFileSync(srtPath, lines.join('\n'), 'utf-8');
  return srtPath;
}

// Cuts [start,end] from sourceVideo, crops to 9:16 (center crop), burns captions.
// ffmpegPath: absolute path resolved by getFfmpeg() in server.js
function cutClip({ ffmpegPath, sourceVideo, start, end, transcriptSegments, outputPath, tmpDir }) {
  return new Promise((resolve, reject) => {
    const duration = end - start;
    const srtPath = path.join(tmpDir, `${path.basename(outputPath, '.mp4')}.srt`);
    writeSrtForClip(transcriptSegments, start, end, srtPath);

    // 9:16 center crop: scale up to cover a 1080x1920 frame, then crop center.
    // This is a simple MVP crop — swap for face-tracking (MediaPipe) later by
    // computing a per-frame crop-x offset and feeding it via a custom filter.
    const escapedSrt = srtPath.replace(/:/g, '\\:').replace(/'/g, "\\'");
    const vf = [
      `scale=1080:1920:force_original_aspect_ratio=increase`,
      `crop=1080:1920`,
      `subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2,Alignment=2,MarginV=80'`
    ].join(',');

    const args = [
      '-y',
      '-ss', String(start),
      '-i', sourceVideo,
      '-t', String(duration),
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      // clean up temp srt regardless of outcome
      try { fs.unlinkSync(srtPath); } catch {}
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.slice(-800)}`));
      resolve(outputPath);
    });
  });
}

module.exports = { cutClip, writeSrtForClip };
