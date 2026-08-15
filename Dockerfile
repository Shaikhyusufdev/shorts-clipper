FROM node:20-slim

# System deps: python3 (yt-dlp needs it), ffmpeg (video processing).
# unzip + ca-certificates are required by the Deno installer below.
# No more faster-whisper/pip whisper model — transcription now goes through
# Groq's hosted API instead of running locally, so we don't need the local
# whisper model or its weight baked into this image anymore. Smaller image,
# faster build, and no local CPU/RAM spent on transcription.
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl ca-certificates unzip \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --break-system-packages "yt-dlp[default]" && \
    yt-dlp --version

# Deno solves YouTube's "n challenge" (anti-bot signature) far more reliably
# inside containers than Node.js does — yt-dlp auto-prioritizes deno over
# node once it's on PATH, no extra flags needed.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    deno --version

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
