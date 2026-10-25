
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./

RUN npm ci --include=dev

COPY . .

# Next.js standalone does not automatically copy public assets.
RUN mkdir -p public

RUN npm run build

# No local environment files may enter the runtime output.
RUN find .next/standalone -type f -name '.env*' -delete \
    && ! find .next/standalone -type f -name '.env*' | grep -q .

# Production runtime
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Media metadata, video processing and HTTPS support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libimage-exiftool-perl \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

RUN mkdir -p /app/.next/cache \
    && chown -R node:node /app/.next \
    && ! find /app -type f -name '.env*' | grep -q .

USER node

EXPOSE 3000

CMD ["node", "server.js"]
