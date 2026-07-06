# Render's native (non-Docker) build environment runs its build step in a
# locked-down sandbox with a read-only /var/lib/apt -- `apt-get install`
# fails there ("Read-only file system"), so a real system ffmpeg can't be
# installed that way. This Dockerfile installs it at *image build time*
# instead, where apt-get runs as root with full filesystem access, giving a
# properly compiled, dynamically-linked ffmpeg/ffprobe baked into the image.
# That avoids the SIGSEGV crash the bundled static binaries hit in Render's
# runtime container (confirmed in production against two different static
# builds).
FROM node:20-bookworm-slim

# Suppresses debconf trying (and failing) to use an interactive Perl
# prompt module that isn't in this slim image -- harmless on its own
# ("Can't locate Term/ReadLine.pm"), but noisy, and this is the standard
# fix for apt installs inside Docker.
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start"]
