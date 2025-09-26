FROM node:20-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM base AS runner
ENV NODE_ENV=production
RUN useradd -m -u 10001 bot
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER bot
CMD ["node", "index.js"]
