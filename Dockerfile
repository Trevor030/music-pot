FROM node:20-bullseye-slim

WORKDIR /app

# yt-dlp binary (no pip/apt)
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
