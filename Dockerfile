FROM node:20-alpine

# ffmpeg + python3 (yt-dlp needs python) + certs
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates && update-ca-certificates

# Add yt-dlp binary directly (no pip needed)
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
