FROM runtime:base

ARG OPENCLAW_VERSION=2026.3.2
RUN npm install -g openclaw@${OPENCLAW_VERSION} \
    && openclaw --version

# Bootstrap config — prevents openclaw from running onboard on first startup
# (which would reset all memory/channels)
RUN mkdir -p /root/openclaw-bootstrap
COPY openclaw/config/openclaw.json /root/openclaw-bootstrap/openclaw.json

EXPOSE 18789
