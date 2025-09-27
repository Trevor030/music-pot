FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends     ffmpeg     python3     ca-certificates  && rm -rf /var/lib/apt/lists/*

ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

# sanitize leading stray "" or BOM in index.js if present
RUN node -e "let fs=require('fs');let s=fs.readFileSync('index.js','utf8');if(s.charCodeAt(0)===0x5C||s.charCodeAt(0)===0xFEFF){fs.writeFileSync('index.js',s.slice(1));console.log('Sanitized leading char');}else{console.log('No sanitize needed')}"

CMD ["node", "index.js"]
