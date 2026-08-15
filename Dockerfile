FROM node:20-slim

# System deps: python3, ffmpeg + build tools for faster-whisper.
# unzip + ca-certificates are required by the Deno installer below.
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl ca-certificates unzip \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --break-system-packages "yt-dlp[default]" faster-whisper && \
    yt-dlp --version

# Deno solves YouTube's "n challenge" (anti-bot signature) far more reliably
# inside containers than Node.js does — yt-dlp auto-prioritizes deno over
# node once it's on PATH, no extra flags needed.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    deno --version

# Bake the "tiny" whisper model + its VAD (voice activity detection) model
# into the image at build time. Without this, the first real request has to
# download them from Hugging Face Hub at runtime — slow, and prone to
# rate-limit/network failures on free-tier hosts (that HF_TOKEN warning you
# saw). Baking them in means zero network dependency during actual use.
RUN ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -y /tmp/warmup.wav && \
    python3 -c "from faster_whisper import WhisperModel; m = WhisperModel('tiny', device='cpu', compute_type='int8'); list(m.transcribe('/tmp/warmup.wav', vad_filter=True)[0])" && \
    rm /tmp/warmup.wav

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN mkdir -p downloads clips transcripts

EXPOSE 3000

# yt-dlp -U self-updates on every boot so we don't need to rebuild the image
# every time YouTube changes its player JS (which breaks the n-challenge
# solver every few weeks). Output is silenced — GitHub's API rate-limits
# unauthenticated checks fairly often on shared free-tier IPs, which isn't
# an actual problem (we just skip the update that boot and carry on), but
# was showing up as a scary-looking red "ERROR" line in the logs.
CMD ["sh", "-c", "yt-dlp -U > /dev/null 2>&1 || true; node server.js"]
