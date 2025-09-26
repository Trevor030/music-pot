FROM node:20-alpine

# ffmpeg via apk (no apt-get)
RUN apk add --no-cache ffmpeg ca-certificates && update-ca-certificates

# Add yt-dlp binary directly (no pip/curl)
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
