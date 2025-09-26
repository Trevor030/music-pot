# Stage 1: bring ffmpeg without apt-get
FROM ghcr.io/jrottenberg/ffmpeg:6.1-ubuntu2204 AS ffmpeg

# Stage 2: Node runtime
FROM node:20

# Copy ffmpeg from stage1 (binaries, libs, etc. under /usr/local)
COPY --from=ffmpeg /usr/local /usr/local

# Add yt-dlp binary directly (no apt/curl needed)
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
