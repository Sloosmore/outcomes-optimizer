FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Copy all workspace package.json files so pnpm can resolve workspace deps
COPY packages/database/package.json ./packages/database/
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-events/package.json ./packages/agent-events/
COPY packages/logger/package.json ./packages/logger/
COPY services/credential-proxy/package.json ./services/credential-proxy/
COPY tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
# Copy source for all workspace deps that credential-proxy imports
COPY packages/logger/ ./packages/logger/
COPY packages/database/ ./packages/database/
COPY packages/agent-events/ ./packages/agent-events/
COPY packages/agent-core/ ./packages/agent-core/
COPY services/credential-proxy/ ./services/credential-proxy/
# Build workspace deps in order
RUN pnpm --filter @skill-networks/logger build && \
    pnpm --filter @skill-networks/agent-events build && \
    pnpm --filter @skill-networks/database build && \
    pnpm --filter @duoidal/agent-core build
# The @skill-networks/database/drizzle entry (src/drizzle.ts) imports utils/config
# which needs the yaml package and config.yaml — neither available in this container.
# drizzle.ts is excluded from the tsc build, so we patch the exports to point to a
# compiled stub that returns isDatabaseEnabled=false, disabling the optional drizzle
# DatabaseDrain. The credential-proxy queries use getSqlClient() directly (no drizzle).
RUN node -e "const f='packages/database/package.json'; const p=JSON.parse(require('fs').readFileSync(f,'utf-8')); p.exports['./drizzle']='./dist/drizzle-stub.js'; require('fs').writeFileSync(f,JSON.stringify(p,null,2));"
RUN node -e "require('fs').writeFileSync('packages/database/dist/drizzle-stub.js','export function isDatabaseEnabled(){return false;}\nexport function getDb(){throw new Error(\"Drizzle disabled in Docker\");}\nexport async function closeDb(){}\nexport async function _resetForTesting(){}\n');"
WORKDIR /app
CMD ["npx", "tsx", "services/credential-proxy/src/index.ts"]
