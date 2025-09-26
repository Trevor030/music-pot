FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    ca-certificates \ && rm -rf /var/lib/apt/lists/*

RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \    -O /usr/local/bin/yt-dlp \ && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
