import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
// Resolve the font package's real disk location so Vite can serve it even when
// node_modules is a symlink pointing outside the worktree fs.allow boundary.
const geistDir = path.dirname(require.resolve('@fontsource-variable/geist/package.json'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contracts': path.resolve(__dirname, './contracts'),
      '@skill-networks/contracts': path.resolve(__dirname, './contracts'),
      '@skill-networks/agent-events': path.resolve(__dirname, '../../packages/agent-events/src/index.ts'),
      '@duoidal/auth/adapters': path.resolve(__dirname, '../../packages/auth/src/adapters/index.ts'),
      '@duoidal/auth': path.resolve(__dirname, '../../packages/auth/src/index.ts'),
    },
    // Force a single React instance — prevents "invalid hook call" from workspace
    // packages (agent-events) that carry their own copy of React in node_modules.
    dedupe: ['react', 'react-dom', '@xyflow/react'],
  },
  // @skill-networks/logger reads process.env.LOG_LEVEL at module load time via
  // agent-events → supabase-event-emitter. Stub process so the browser doesn't crash.
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.LOG_LEVEL': 'undefined',
    'process.platform': '"browser"',
  },
  server: {
    strictPort: false,
    fs: {
      allow: [path.resolve(__dirname, '../..'), geistDir],
    },
    proxy: (() => {
      // Allow BFF_PROXY_URL to be overridden for Docker Compose environments where
      // the BFF runs in a separate container (e.g. http://dashboard-bff:3001).
      const bff = process.env['BFF_PROXY_URL'] ?? 'http://localhost:3001'
      return {
        '/api': bff,
        '/token': bff,
        '/health': bff,
        // List each /auth/* BFF route explicitly. /auth/callback is intentionally absent —
        // it is a frontend route handled by src/routes/auth.callback.tsx. Any new backend
        // /auth/* route must be added here or it will silently return the frontend HTML.
        '/auth': bff,
        '/dev': bff,
      }
    })(),
  },
})
