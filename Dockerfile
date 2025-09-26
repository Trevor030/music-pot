FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir -U yt-dlp
WORKDIR /app
COPY package.json package-lock.json* ./ 
RUN npm install --omit=dev
COPY . .
CMD ["node", "index.js"]
