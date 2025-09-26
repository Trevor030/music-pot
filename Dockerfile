FROM node:20-bookworm-slim AS base
RUN apt-get update  && apt-get install -y --no-install-recommends ffmpeg  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install deps (no native toolchain needed thanks to opusscript)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Runtime
COPY . .
CMD ["node", "index.js"]
