# Base Node (glibc) – serve solo per eseguire il bot
FROM node:20-bullseye-slim

WORKDIR /app

# 1) yt-dlp: binario già pronto (niente pip/python durante la build)
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# 2) ffmpeg: binari statici (niente apt)
ADD https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz /tmp/ffmpeg.tar.xz
RUN tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
 && mv /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg \
 && mv /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe \
 && chmod a+rx /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
 && rm -rf /tmp/ffmpeg-*-amd64-static /tmp/ffmpeg.tar.xz

# 3) dipendenze Node del bot
COPY package*.json ./
RUN npm install --omit=dev

# 4) sorgenti
COPY . .

# Avvio
CMD ["npm", "start"]
