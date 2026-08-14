FROM node:20-slim

# System deps: python3, ffmpeg (same as noxload) + build tools for faster-whisper
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl --no-install-recommends && \
    pip3 install yt-dlp faster-whisper --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN mkdir -p downloads clips transcripts

EXPOSE 3000
CMD ["node", "server.js"]
