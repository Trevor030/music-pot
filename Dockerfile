FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends     ffmpeg     python3     ca-certificates  && rm -rf /var/lib/apt/lists/*

ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
