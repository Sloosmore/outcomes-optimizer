FROM node:22-alpine AS builder
WORKDIR /build

# Install esbuild and supabase-js for bundling
RUN npm install esbuild @supabase/supabase-js tsx --ignore-scripts

# Copy source files
COPY packages/artifact-url/src/index.ts ./artifact_url_pkg/index.ts
COPY services/artifact-router/src/server.ts ./server.ts

# Patch the import to resolve locally before bundling
RUN sed -i "s|from '@skill-networks/artifact-url'|from './artifact_url_pkg/index.ts'|g" server.ts

# Bundle everything into a single CommonJS file
RUN node_modules/.bin/esbuild server.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --outfile=server.cjs \
      --external:node:*

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app

# Only need supabase-js at runtime (not bundled because it uses dynamic requires)
RUN npm install @supabase/supabase-js --ignore-scripts

COPY --from=builder /build/server.cjs ./server.cjs

EXPOSE 8080
ENV NODE_ENV=production

CMD ["node", "server.cjs"]
