import { Hono } from 'hono'
import { jwtMiddleware } from './middleware/jwt.js'
import { healthRouter } from './routes/health.js'
import { tokenRouter } from './routes/token.js'
import { authRouter } from './routes/auth.js'
import { graphRouter } from './routes/graph.js'
import { resourcesRouter } from './routes/resources.js'
import { processesRouter } from './routes/processes.js'
import { eventsRouter } from './routes/events.js'
import { chatsRouter } from './routes/chats.js'
import { messagesRouter } from './routes/messages.js'
import { toolsRouter } from './routes/tools.js'
import { chatConfigRouter } from './routes/chat-config.js'
import { chatStreamRouter } from './routes/chat-stream.js'
import { orgRouter } from './routes/org.js'
import { previewRouter } from './routes/preview.js'
import { metricsRouter } from './routes/metrics.js'
import { createSandboxRouter, createReadyRouter } from './routes/sandbox.js'
import { userRouter } from './routes/user.js'
import { githubCallbackRouter, githubRouter } from './routes/github.js'
import { skillsRouter } from './routes/skills.js'
import { createVoiceToolCtxRouter } from './routes/voice-tool-ctx.js'
import { debugLogRouter } from './routes/debug-log.js'
import { supabase } from './lib/supabase.js'
import { createSandboxProvider } from '@duoidal/sandbox'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:app')

const readyRouter = createReadyRouter({ db: supabase })
let sandboxRouter: Hono
try {
  const _sandboxProvider = createSandboxProvider()
  sandboxRouter = createSandboxRouter({ db: supabase, provider: _sandboxProvider })
} catch (err) {
  logger.warn('Sandbox provider unavailable', { error: err instanceof Error ? err.message : String(err) })
  sandboxRouter = new Hono()
  sandboxRouter.all('/*', (c) => c.json({ error: 'Sandbox not configured' }, 503))
}

const app = new Hono()

// ── Unauthenticated routes (registered BEFORE the JWT wall) ──────────────────
app.route('/health', healthRouter)
app.route('/token', tokenRouter)
app.route('/auth', authRouter)
if (process.env['NODE_ENV'] === 'development') {
  const { devRouter } = await import('./routes/dev.js')
  app.route('/dev', devRouter)
}
app.route('/sandbox', readyRouter)  // provision-secret protected, not JWT
app.route('/github', githubCallbackRouter)
app.route('/api/skills', skillsRouter)  // public — skill tarballs from a public repo, no auth needed
app.route('/api/voice-tool', createVoiceToolCtxRouter({ db: supabase }))  // voice-tool JWT auth, not Supabase JWT
app.route('/api/debug-log', debugLogRouter)  // X-Debug-Log-Secret header auth — sink for LK Cloud worker stdout (no other path to read it)

// ── Auth wall ────────────────────────────────────────────────────────────────
app.use('/api/*', jwtMiddleware)

// ── Authenticated routes (registered AFTER the JWT wall) ─────────────────────
app.route('/api/graph', graphRouter)
app.route('/api', resourcesRouter)      // handles /api/resources, /api/resource-links, /api/resource-types
app.route('/api', processesRouter)      // handles /api/processes, /api/process-events/:id
app.route('/api/events', eventsRouter)
app.route('/api/chats', chatsRouter)
app.route('/api/chats', messagesRouter)
app.route('/api/tools', toolsRouter)
app.route('/api/chat/config', chatConfigRouter)
app.route('/api/chat', chatStreamRouter)
app.route('/api/org', orgRouter)
app.use('/preview/*', jwtMiddleware)  // /preview is not under /api/* so needs its own jwt guard
app.route('/preview', previewRouter)
app.route('/api/metrics', metricsRouter)
app.route('/api/sandbox', sandboxRouter)
app.route('/api/github', githubRouter)
app.route('/api', userRouter)  // handles /api/onboarded

export default app
