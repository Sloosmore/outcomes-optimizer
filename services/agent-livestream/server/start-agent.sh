#!/bin/sh
# The BFF runs on Vercel; the worker reaches it via the BFF_URL env secret.
# Do not start the BFF locally here — it will hang without DB credentials.
exec npx tsx server/voice-agent.ts start
