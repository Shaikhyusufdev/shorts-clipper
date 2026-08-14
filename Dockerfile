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

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN mkdir -p downloads clips transcripts

EXPOSE 3000

# yt-dlp -U self-updates on every boot so we don't need to rebuild the image
# every time YouTube changes its player JS (which breaks the n-challenge
# solver every few weeks). Adds ~2-3s to cold start, worth it.
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
