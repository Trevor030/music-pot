FROM node:20-slim

WORKDIR /app

# yt-dlp + ffmpeg + python3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    wget \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install -U yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
