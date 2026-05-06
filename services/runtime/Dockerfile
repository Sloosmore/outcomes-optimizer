FROM debian:bookworm-slim

ENV NODE_VERSION=22.13.1

# Install system dependencies
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y --no-install-recommends \
         xz-utils ca-certificates git libfuse2 netcat-openbsd curl procps iproute2 openssh-client tmux jq python3 \
         ffmpeg postgresql-client \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm tsx

# GitHub CLI — for agent to clone repos, open PRs, etc.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && gh --version

# Doppler CLI — for agent to fetch secrets at runtime
ARG DOPPLER_VERSION=3.75.3
RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
    && curl -fsSL https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key \
      | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/doppler-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
      > /etc/apt/sources.list.d/doppler-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends "doppler=${DOPPLER_VERSION}" \
    && apt-get purge -y --auto-remove gnupg \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && doppler --version

# Claude Code CLI — for headless agent runs
ARG CLAUDE_CODE_VERSION=2.1.72
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version

# tigrisfs — FUSE driver for R2 persistent storage
ARG TIGRISFS_VERSION=1.2.1
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz \
    && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ tigrisfs \
    && rm /tmp/tigrisfs.tar.gz \
    && tigrisfs --version

# CLIProxyAPI — credential proxy for Claude API routing
ARG CLIPROXYAPI_VERSION=6.9.18
RUN ARCH="$(dpkg --print-architecture)" \
    && SHA256_AMD64="10f941b59e8eb5e1a67ff53998e1f49a929ab6d510844c46aee645e2b2462685" \
    && SHA256_ARM64="d9794514f255df54094f12ff64df76017c2756dea091ced837b2f71f3c3ebf6b" \
    && case "${ARCH}" in \
         amd64) EXPECTED="${SHA256_AMD64}" ;; \
         arm64) EXPECTED="${SHA256_ARM64}" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}/CLIProxyAPI_${CLIPROXYAPI_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/cliproxyapi.tar.gz \
    && echo "${EXPECTED}  /tmp/cliproxyapi.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/cliproxyapi.tar.gz -C /usr/local/bin/ cli-proxy-api \
    && mv /usr/local/bin/cli-proxy-api /usr/local/bin/cliproxyapi \
    && chmod +x /usr/local/bin/cliproxyapi \
    && rm /tmp/cliproxyapi.tar.gz \
    # cliproxyapi --version exits non-zero even on success; grep on the expected string to verify the binary works
    && cliproxyapi --version 2>&1 | grep -q "CLIProxyAPI Version"

RUN mkdir -p /opt/cliproxyapi/auths
COPY cliproxyapi-config.yaml /opt/cliproxyapi/config.yaml

# Bump to force cache invalidation for start.sh
RUN echo "cache-bust: 2026-04-09-v1"
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

CMD ["/usr/local/bin/start.sh"]
