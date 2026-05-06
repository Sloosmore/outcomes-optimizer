FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Copy root manifest files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy all workspace package manifests so pnpm can resolve the workspace
COPY packages/auth/package.json ./packages/auth/
COPY packages/duoidal-cli/package.json ./packages/duoidal-cli/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-email/package.json ./packages/agent-email/
COPY packages/agent-media/package.json ./packages/agent-media/
COPY packages/agent-instagram/package.json ./packages/agent-instagram/
COPY packages/agent-youtube/package.json ./packages/agent-youtube/
COPY packages/agent-hooks/package.json ./packages/agent-hooks/
COPY packages/agent-events/package.json ./packages/agent-events/
COPY packages/database/package.json ./packages/database/
COPY services/agent-interceptor/package.json ./services/agent-interceptor/
COPY services/agent-livestream/contracts/package.json ./services/agent-livestream/contracts/
COPY services/agent-livestream/package.json ./services/agent-livestream/
COPY services/credential-proxy/package.json ./services/credential-proxy/
COPY services/doppler-secrets/package.json ./services/doppler-secrets/
COPY packages/logger/package.json ./packages/logger/
COPY utils/package.json ./utils/

# Install workspace deps (creates symlinks to workspace package dirs)
RUN corepack enable && pnpm install --frozen-lockfile --filter agent-livestream

# Copy workspace package sources that agent-livestream actually uses
COPY packages/database/ ./packages/database/
COPY packages/agent-events/ ./packages/agent-events/
COPY packages/logger/ ./packages/logger/
COPY services/agent-livestream/ ./services/agent-livestream/
COPY packages/auth/ ./packages/auth/
COPY packages/sandbox/ ./packages/sandbox/
COPY packages/duoidal-cli/skills.manifest.json ./packages/duoidal-cli/
COPY utils/ ./utils/

WORKDIR /app/services/agent-livestream

# Create the LiveKit Cloud Agents entry point (platform executes /etc/run/run.sh).
# The BFF runs on Vercel — the worker reaches it via the BFF_URL secret. Starting
# the BFF locally inside this container hangs forever (missing env, no DB), and
# the prior `until curl localhost:3001/health` gate kept voice-agent.ts from ever
# starting, so the worker never registered with LiveKit and rooms got no agent.
RUN mkdir -p /etc/run && \
    printf '#!/bin/sh\nexec npx tsx server/voice-agent.ts start\n' > /etc/run/run.sh && \
    chmod +x /etc/run/run.sh
CMD ["/etc/run/run.sh"]
