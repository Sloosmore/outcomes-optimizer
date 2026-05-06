#!/usr/bin/env node
/**
 * research.mjs — runs INSIDE the sandbox VM.
 *
 * Thin wrapper around @anthropic-ai/claude-agent-sdk. The SDK does the work:
 * tool use, file generation, and producing a final text answer. When the SDK
 * decides to render an artifact, it calls our in-process MCP tool
 * `register_artifact` which deterministically picks a free port, spawns a
 * detached HTTP server, and returns the canonical artifact URL — eliminating
 * the prior "model hallucinates the port/UUID" failure mode.
 *
 * Contract:
 *   stdout (final line): {"text":"..."}
 *
 * Environment (set by sandbox-agent-runner.ts):
 *   ANTHROPIC_BASE_URL  — local CLIProxyAPI on the sandbox (Anthropic-shape proxy)
 *   ANTHROPIC_API_KEY   — proxy allow-list key (NOT a real Anthropic key)
 *   SANDBOX_ID          — sandbox resource id, baked into the artifact URL
 *   SANDBOX_MODEL       — model id the proxy advertises
 *
 * Working directory is /opt/sandbox-research (has the SDK in node_modules).
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const execFileAsync = promisify(execFile)

const prompt = process.argv[2] ?? process.env['RESEARCH_PROMPT'] ?? ''
const sandboxId = process.env['SANDBOX_ID'] ?? ''
const model = process.env['SANDBOX_MODEL'] ?? 'claude-sonnet-4-5-20250929'

if (!prompt) {
  process.stderr.write('research.mjs: no prompt provided\n')
  process.stdout.write(JSON.stringify({ text: 'No prompt provided.' }) + '\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// In-process MCP server: register_artifact
// ---------------------------------------------------------------------------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr !== 'object' || !addr.port) {
        srv.close(() => reject(new Error('findFreePort: srv.address() returned no port')))
        return
      }
      srv.close(() => resolve(addr.port))
    })
  })
}

const ARTIFACT_ROOT = '/tmp/artifacts'
// Cap on detached python http.server children kept alive concurrently per
// SDK session. Bumped 4 → 8 so parallel claude_code calls (orchestrator
// firing multiple tool_use in one turn) don't trip the limit when each
// produces its own artifact tile.
const MAX_ARTIFACT_SERVERS = 8
let artifactServerCount = 0

// Lazy-install pandoc on first use. Cached after first install — subsequent
// calls are no-ops. Pandoc renders markdown to a static HTML file once;
// served by python3 http.server (already detached and stable). This
// replaces the previous grip approach which (a) hit the GitHub API on
// every render (rate-limit risk) and (b) lived in a Flask process that
// died with its parent SDK session.
let pandocInstallPromise = null
async function ensurePandocInstalled() {
  if (pandocInstallPromise) return pandocInstallPromise
  pandocInstallPromise = (async () => {
    try {
      await execFileAsync('which', ['pandoc'], { timeout: 5_000 })
      return
    } catch { /* not installed — fall through */ }
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
    try {
      await execFileAsync('apt-get', ['install', '-y', '--no-install-recommends', 'pandoc'], {
        timeout: 180_000,
        env,
      })
    } catch {
      // Retry after apt-get update (image may not have a fresh package list).
      await execFileAsync('apt-get', ['update', '-y'], { timeout: 120_000 })
      await execFileAsync('apt-get', ['install', '-y', '--no-install-recommends', 'pandoc'], {
        timeout: 180_000,
        env,
      })
    }
    await execFileAsync('which', ['pandoc'], { timeout: 5_000 })
  })()
  // Reset on failure so a transient network error doesn't permanently disable render_grip.
  pandocInstallPromise.catch(() => { pandocInstallPromise = null })
  return pandocInstallPromise
}

// Slice a string safely without splitting a UTF-16 surrogate pair at the cut point.
function safeSlice(str, maxLen) {
  if (str.length <= maxLen) return str
  let end = maxLen
  const code = str.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return str.slice(0, end)
}

// Minimal GitHub-flavored CSS inlined into every rendered doc. Keeps the
// artifact a single self-contained file with no CDN dependency. Adapted
// from sindresorhus/github-markdown-css (MIT) — trimmed to the rules that
// actually fire on the tags pandoc emits.
const GITHUB_MD_CSS = `
:root { color-scheme: light; }
body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.5; color: #1f2328; background: #ffffff; word-wrap: break-word; }
h1,h2,h3,h4,h5,h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0b3; }
h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0b3; }
h3 { font-size: 1.25em; } h4 { font-size: 1em; } h5 { font-size: .875em; } h6 { font-size: .85em; color: #59636e; }
p, blockquote, ul, ol, dl, table, pre { margin-top: 0; margin-bottom: 16px; }
a { color: #0969da; text-decoration: none; } a:hover { text-decoration: underline; }
code { padding: .2em .4em; margin: 0; font-size: 85%; background: #818b981f; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
pre { padding: 16px; overflow: auto; font-size: 85%; line-height: 1.45; background: #f6f8fa; border-radius: 6px; }
pre code { padding: 0; background: transparent; border-radius: 0; font-size: 100%; }
blockquote { padding: 0 1em; color: #59636e; border-left: .25em solid #d1d9e0; }
ul, ol { padding-left: 2em; }
table { display: block; width: max-content; max-width: 100%; overflow: auto; border-spacing: 0; border-collapse: collapse; }
table th, table td { padding: 6px 13px; border: 1px solid #d1d9e0; }
table tr { background: #ffffff; border-top: 1px solid #d1d9e0b3; }
table tr:nth-child(2n) { background: #f6f8fa; }
hr { height: .25em; padding: 0; margin: 24px 0; background: #d1d9e0; border: 0; }
img { max-width: 100%; box-sizing: content-box; }
input[type=checkbox] { margin: 0 .2em .25em -1.4em; vertical-align: middle; }
ul.task-list { list-style: none; padding-left: 1.4em; }
`.trim()

function waitForPort(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const attempt = () => {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => {
        if (Date.now() - start < timeoutMs) setTimeout(attempt, 50)
        else resolve(false)
      })
    }
    attempt()
  })
}

// Puppeteer config that mmdc uses to launch headless Chrome as root.
// Provisioned by bootstrap.sh; we re-create best-effort if missing.
const PUPPETEER_CONFIG = '/opt/sandbox-research/puppeteer-config.json'
function ensurePuppeteerConfig() {
  if (!existsSync(PUPPETEER_CONFIG)) {
    try {
      writeFileSync(PUPPETEER_CONFIG, '{"args":["--no-sandbox","--disable-setuid-sandbox"]}')
    } catch { /* best effort */ }
  }
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Mermaid preview HTML — ported from server/mcp-servers/mermaid-preview-html.ts
// (PR #966). Adds: canvas-fit viewport, pan/zoom controls, SVG background
// extraction (so the diagram tile blends with surrounding chrome), and SVG
// sanitization (strips javascript:/data: URIs and external use/image refs to
// prevent SSRF and XSS via SVG-to-PNG converters or non-browser consumers).
const MERMAID_STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; height: 100vh; overflow: hidden;
  background: #1a1a1a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column;
}
.status-bar {
  height: 32px; padding: 8px 16px;
  background: rgba(0, 0, 0, 0.9); color: white; font-size: 12px;
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex-shrink: 0;
}
.toolbar-buttons { display: flex; align-items: center; gap: 8px; }
.toolbar-btn {
  background: transparent; border: none; color: rgba(255, 255, 255, 0.7);
  cursor: pointer; font-size: 16px; padding: 4px 8px;
  transition: color 0.2s, transform 0.2s;
}
.toolbar-btn:hover { color: white; transform: scale(1.1); }
.zoom-level {
  color: rgba(255, 255, 255, 0.5); font-size: 11px;
  min-width: 36px; text-align: center; user-select: none;
}
.status-indicator {
  display: inline-block; width: 8px; height: 8px;
  border-radius: 50%; background: #4caf50; margin-right: 8px;
}
.viewport {
  flex: 1; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  cursor: grab;
}
.diagram-wrapper { padding: 40px; min-width: 100%; transform-origin: 0 0; }
svg {
  display: block;
  max-width: calc(100vw - 80px); max-height: calc(100vh - 112px);
  width: auto !important; height: auto !important;
  margin: 0 auto; pointer-events: none;
}
@media (max-width: 640px) {
  .status-bar { height: auto; flex-wrap: wrap; gap: 4px; }
  #last-update { display: none; }
  .diagram-wrapper { padding: 16px; }
  svg { max-width: calc(100vw - 32px); max-height: calc(100vh - 80px); }
}
`

const MERMAID_SCRIPT = `
(function () {
  var MIN_SCALE = 0.1, MAX_SCALE = 10;
  var ZOOM_BUTTON_FACTOR = 1.2, WHEEL_ZOOM_FACTOR = 0.001;
  var viewport = document.querySelector('.viewport');
  var wrapper = document.querySelector('.diagram-wrapper');
  var zoomLevel = document.getElementById('zoom-level');
  var pan = { x: 0, y: 0, scale: 1, dragging: false, startX: 0, startY: 0 };

  function clamp(v) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)); }
  function apply() {
    if (wrapper) {
      wrapper.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + pan.scale + ')';
    }
    if (zoomLevel) zoomLevel.textContent = Math.round(pan.scale * 100) + '%';
  }
  function zoomAt(newScale, px, py) {
    newScale = clamp(newScale);
    var ratio = 1 - newScale / pan.scale;
    pan.x += (px - pan.x) * ratio;
    pan.y += (py - pan.y) * ratio;
    pan.scale = newScale;
    apply();
  }
  function zoomCenter(newScale) {
    if (!viewport) return;
    var rect = viewport.getBoundingClientRect();
    zoomAt(newScale, rect.width / 2, rect.height / 2);
  }
  function reset() { pan.x = 0; pan.y = 0; pan.scale = 1; apply(); }

  function onWheel(e) {
    if (!viewport) return;
    e.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 40;
    else if (e.deltaMode === 2) dy *= 800;
    var delta = -dy * WHEEL_ZOOM_FACTOR;
    zoomAt(pan.scale * (1 + delta), e.clientX - rect.left, e.clientY - rect.top);
  }
  function onMouseDown(e) {
    if (!viewport || e.target.closest('.status-bar')) return;
    pan.dragging = true;
    pan.startX = e.clientX - pan.x;
    pan.startY = e.clientY - pan.y;
    viewport.style.cursor = 'grabbing';
    e.preventDefault();
  }
  function onMouseUp() {
    pan.dragging = false;
    if (viewport) viewport.style.cursor = 'grab';
  }
  function onMouseMove(e) {
    if (!viewport || !pan.dragging) return;
    pan.x = e.clientX - pan.startX;
    pan.y = e.clientY - pan.startY;
    apply();
  }
  function onTouchStart(e) {
    if (!viewport || e.target.closest('.status-bar') || e.touches.length !== 1) return;
    pan.dragging = true;
    pan.startX = e.touches[0].clientX - pan.x;
    pan.startY = e.touches[0].clientY - pan.y;
    e.preventDefault();
  }
  function onTouchMove(e) {
    if (!pan.dragging || e.touches.length !== 1) return;
    pan.x = e.touches[0].clientX - pan.startX;
    pan.y = e.touches[0].clientY - pan.startY;
    apply();
    e.preventDefault();
  }
  function onTouchEnd() { pan.dragging = false; }

  if (viewport) {
    viewport.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    viewport.addEventListener('mousemove', onMouseMove);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('touchstart', onTouchStart, { passive: false });
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd);
    viewport.style.cursor = 'grab';
  }
  var zoomIn = document.getElementById('zoom-in');
  var zoomOut = document.getElementById('zoom-out');
  var resetBtn = document.getElementById('reset-pan');
  if (zoomIn) zoomIn.addEventListener('click', function () { zoomCenter(pan.scale * ZOOM_BUTTON_FACTOR); });
  if (zoomOut) zoomOut.addEventListener('click', function () { zoomCenter(pan.scale / ZOOM_BUTTON_FACTOR); });
  if (resetBtn) resetBtn.addEventListener('click', reset);
})();
`

function sanitizeMermaidSvg(svg) {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s/>]+)/gi, '')
    .replace(/(\s+(?:href|xlink:href|src|action|formaction)\s*=\s*")(?:javascript|data):[^"]*/gi, '$1#')
    .replace(/(\s+(?:href|xlink:href|src|action|formaction)\s*=\s*')(?:javascript|data):[^']*/gi, "$1#")
    .replace(/(<(?:use|image)\b[^>]*?\s(?:href|xlink:href)\s*=\s*")(?!#)[^"]*/gi, '$1#')
    .replace(/(<(?:use|image)\b[^>]*?\s(?:href|xlink:href)\s*=\s*')(?!#)[^']*/gi, "$1#")
}

function extractMermaidSvgBg(svgContent) {
  const opening = svgContent.match(/<svg\b[^>]*>/i)
  if (!opening) return null
  const styleAttr = opening[0].match(/style\s*=\s*"([^"]*)"/i)
  if (!styleAttr) return null
  const bg = styleAttr[1].match(/background(?:-color)?\s*:\s*([^;]+)/i)
  if (!bg) return null
  const value = bg[1].trim()
  if (!/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|transparent)$/.test(value)) {
    return null
  }
  return value
}

const MERMAID_HTML_TEMPLATE = (svgContent, title) => {
  const safeTitle = escapeHtml(title)
  const timestamp = escapeHtml(new Date().toLocaleTimeString())
  const svgBg = extractMermaidSvgBg(svgContent) ?? '#1a1a1a'
  const viewportStyle = `background: ${escapeHtml(svgBg)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Mermaid: ${safeTitle}</title>
<style>${MERMAID_STYLE}</style>
</head>
<body data-diagram-id="${safeTitle}">
<div class="status-bar">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div>
      <span class="status-indicator"></span>
      <span>Static View</span>
    </div>
    <div class="toolbar-buttons">
      <button class="toolbar-btn" id="zoom-out" title="Zoom out">−</button>
      <span class="zoom-level" id="zoom-level">100%</span>
      <button class="toolbar-btn" id="zoom-in" title="Zoom in">+</button>
      <button class="toolbar-btn" id="reset-pan" title="Reset position">⊙</button>
    </div>
  </div>
  <div id="last-update">Rendered: ${timestamp}</div>
</div>
<div class="viewport" style="${viewportStyle}">
  <div class="diagram-wrapper">${sanitizeMermaidSvg(svgContent)}</div>
</div>
<script>${MERMAID_SCRIPT}</script>
</body>
</html>`
}

const artifactServer = createSdkMcpServer({
  name: 'sandbox-artifact',
  version: '1.0.0',
  tools: [
    tool(
      'render_mermaid',
      'Render a Mermaid diagram to SVG, wrap it in a self-contained HTML page, spawn a detached HTTP server, and return the canonical artifact URL. Use this when the user wants a Mermaid diagram — it eliminates CDN flakiness and produces a deterministic image that always renders. Faster and more reliable than writing HTML+CDN by hand and calling register_artifact.',
      {
        diagram: z
          .string()
          .min(1)
          .describe(
            'Mermaid source code (e.g. "graph TD\\n  A-->B\\n  B-->C"). Do not include code fences or surrounding markdown — pass the raw mermaid syntax only.',
          ),
        theme: z
          .enum(['default', 'forest', 'dark', 'neutral'])
          .optional()
          .describe('Mermaid theme. Defaults to "default".'),
        title: z
          .string()
          .optional()
          .describe('Optional page title shown in the browser tab. Defaults to "Diagram".'),
      },
      async ({ diagram, theme = 'default', title = 'Diagram' }) => {
        if (!sandboxId) {
          return { content: [{ type: 'text', text: 'ERROR: SANDBOX_ID env var is empty.' }] }
        }
        if (!/^[a-zA-Z0-9-]+$/.test(sandboxId)) {
          return { content: [{ type: 'text', text: 'ERROR: SANDBOX_ID contains invalid characters.' }] }
        }
        if (diagram.includes('--- END MERMAID SOURCE ---')) {
          return { content: [{ type: 'text', text: 'ERROR: diagram source contains reserved delimiter sequence.' }] }
        }
        ensurePuppeteerConfig()
        const id = randomUUID().replace(/-/g, '').slice(0, 16)
        const dir = `${ARTIFACT_ROOT}/mermaid-${id}`
        mkdirSync(dir, { recursive: true })
        const mmdPath = `${dir}/diagram.mmd`
        const svgPath = `${dir}/diagram.svg`
        writeFileSync(mmdPath, diagram)
        try {
          await execFileAsync(
            'mmdc',
            ['-i', mmdPath, '-o', svgPath, '-t', theme, '-b', 'transparent', '-p', PUPPETEER_CONFIG],
            { timeout: 60_000 },
          )
        } catch (err) {
          const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(0, 500) : ''
          return { content: [{ type: 'text', text: `ERROR: mmdc failed: ${err instanceof Error ? err.message : String(err)}\n${stderr}` }] }
        }
        if (!existsSync(svgPath)) {
          return { content: [{ type: 'text', text: 'ERROR: mmdc completed but did not produce an SVG.' }] }
        }
        const svg = readFileSync(svgPath, 'utf-8')
        writeFileSync(`${dir}/index.html`, MERMAID_HTML_TEMPLATE(svg, title))
        // Reuse the same spawn-detached-server logic as register_artifact below.
        if (artifactServerCount >= MAX_ARTIFACT_SERVERS) {
          return { content: [{ type: 'text', text: `ERROR: too many artifact servers (max ${MAX_ARTIFACT_SERVERS}).` }] }
        }
        const port = await findFreePort()
        const child = spawn(
          'python3',
          ['-m', 'http.server', String(port), '--directory', dir, '--bind', '0.0.0.0'],
          { detached: true, stdio: 'ignore', cwd: '/tmp' },
        )
        child.on('error', (e) => process.stderr.write(`render_mermaid spawn: ${e.message}\n`))
        child.unref()
        const ready = await waitForPort(port)
        if (!ready) return { content: [{ type: 'text', text: `ERROR: server on port ${port} did not become ready.` }] }
        artifactServerCount++
        const url = `https://artifact-${sandboxId}-${port}.example.com/`
        // Return the rendered URL AND the source mermaid so the orchestrator
        // (which only sees the subagent's final text answer) gets the full
        // source. Without this, follow-up questions like "what was in the
        // diagram?" require re-running the subagent.
        // Cap the *echoed* source only — the file on disk always contains the full content.
        const diagramEcho = diagram.length > 12_000
          ? safeSlice(diagram, 12_000) + `\n\n[…truncated; full source is ${diagram.length} chars, served at ${url}]`
          : diagram
        return {
          content: [{
            type: 'text',
            text: `Mermaid diagram rendered.\n  url: ${url}\n  port: ${port}\n  directory: ${dir}\nUse this exact URL in your final answer, and INCLUDE the source below verbatim in a fenced \`mermaid\` block so the orchestrator has the diagram source in context.\n\n--- BEGIN MERMAID SOURCE ---\n${diagramEcho}\n--- END MERMAID SOURCE ---`,
          }],
        }
      },
    ),
    tool(
      'render_grip',
      'Render a markdown document as a GitHub-styled HTML page using `grip`, spawn a detached HTTP server, and return the canonical artifact URL. Use this for ANY markdown the user asks you to produce (PRD, design doc, README, notes, spec, writeup). Faster and richer than register_artifact because grip handles GFM (tables, fences, task lists, headings) automatically — do not hand-roll HTML for markdown content.',
      {
        markdown: z
          .string()
          .min(1)
          .describe(
            'Raw markdown source (GitHub-flavored). Do NOT wrap in code fences. Include headings, lists, tables, code blocks as needed. grip will render it the same way GitHub renders a README.',
          ),
        title: z
          .string()
          .optional()
          .describe('Optional page title for the browser tab. Defaults to "Document".'),
      },
      async ({ markdown, title = 'Document' }) => {
        if (!sandboxId) {
          return { content: [{ type: 'text', text: 'ERROR: SANDBOX_ID env var is empty.' }] }
        }
        if (!/^[a-zA-Z0-9-]+$/.test(sandboxId)) {
          return { content: [{ type: 'text', text: 'ERROR: SANDBOX_ID contains invalid characters.' }] }
        }
        if (markdown.includes('--- END MARKDOWN SOURCE ---')) {
          return { content: [{ type: 'text', text: 'ERROR: markdown source contains reserved delimiter sequence.' }] }
        }
        if (artifactServerCount >= MAX_ARTIFACT_SERVERS) {
          return { content: [{ type: 'text', text: `ERROR: too many artifact servers (max ${MAX_ARTIFACT_SERVERS}).` }] }
        }
        // Ensure pandoc is installed (lazy first-use install). We render
        // markdown to a static index.html once, then serve via python3
        // http.server — no GitHub API call, no Flask reloader, no rate
        // limit, and the server actually survives parent termination
        // (python3 -m http.server is a clean detached child, unlike grip
        // which wraps a Flask reloader that holds parent fds).
        try {
          await ensurePandocInstalled()
        } catch (err) {
          return { content: [{ type: 'text', text: `ERROR: could not install pandoc: ${err instanceof Error ? err.message : String(err)}` }] }
        }
        const id = randomUUID().replace(/-/g, '').slice(0, 16)
        const dir = `${ARTIFACT_ROOT}/grip-${id}`
        mkdirSync(dir, { recursive: true })
        const mdPath = `${dir}/README.md`
        const cssPath = `${dir}/style.css`
        const htmlPath = `${dir}/index.html`
        // Prepend an h1 with the supplied title only if the markdown doesn't
        // already start with one — keeps the user's original heading hierarchy.
        const titleHeader = /^\s*#\s/.test(markdown) ? '' : `# ${title}\n\n`
        writeFileSync(mdPath, `${titleHeader}${markdown}`)
        writeFileSync(cssPath, GITHUB_MD_CSS)
        // pandoc -f gfm -t html5 -s --metadata title=... --css style.css -o index.html README.md
        // -s/--standalone: emit a full <html> document, not a fragment.
        // gfm input: matches GitHub-flavored markdown (tables, task lists, fenced code).
        try {
          await execFileAsync(
            'pandoc',
            [
              '-f', 'gfm',
              '-t', 'html5',
              '-s',
              '--metadata', `title=${title}`,
              '--css', 'style.css',
              '-o', htmlPath,
              mdPath,
            ],
            { timeout: 30_000 },
          )
        } catch (err) {
          const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).slice(0, 500) : ''
          return { content: [{ type: 'text', text: `ERROR: pandoc failed: ${err instanceof Error ? err.message : String(err)}\n${stderr}` }] }
        }
        if (!existsSync(htmlPath)) {
          return { content: [{ type: 'text', text: 'ERROR: pandoc completed but did not produce index.html.' }] }
        }
        // Serve with python3 http.server — same pattern as render_mermaid /
        // register_artifact, which we know survives parent termination.
        const port = await findFreePort()
        const child = spawn(
          'python3',
          ['-m', 'http.server', String(port), '--directory', dir, '--bind', '0.0.0.0'],
          { detached: true, stdio: 'ignore', cwd: '/tmp' },
        )
        child.on('error', (e) => process.stderr.write(`render_grip spawn: ${e.message}\n`))
        child.unref()
        const ready = await waitForPort(port)
        if (!ready) {
          return { content: [{ type: 'text', text: `ERROR: server on port ${port} did not become ready.` }] }
        }
        artifactServerCount++
        const url = `https://artifact-${sandboxId}-${port}.example.com/`
        // Return the rendered URL AND the source markdown so the orchestrator
        // (which only sees the subagent's final text answer) gets the full
        // document body. Without this, follow-up questions like "summarize
        // the goal you just made" require re-running the subagent.
        // Cap the *echoed* source only — the file on disk always contains the full content.
        const sourceEcho = markdown.length > 12_000
          ? safeSlice(markdown, 12_000) + `\n\n[…truncated; full source is ${markdown.length} chars, served at ${url}]`
          : markdown
        return {
          content: [{
            type: 'text',
            text: `Markdown rendered.\n  url: ${url}\n  port: ${port}\n  directory: ${dir}\nUse this exact URL in your final answer, and INCLUDE the source below verbatim in a fenced \`markdown\` block so the orchestrator has the document in context.\n\n--- BEGIN MARKDOWN SOURCE ---\n${sourceEcho}\n--- END MARKDOWN SOURCE ---`,
          }],
        }
      },
    ),
    tool(
      'register_artifact',
      'Spawn a detached HTTP server serving the given directory and return its canonical artifact URL. Call this once per artifact you render. The server outlives this turn. Returns the URL to inline in your final answer to the user.',
      {
        directory: z
          .string()
          .describe(
            'Absolute path to the directory containing the artifact files (e.g. /tmp/artifacts/run-<id>/). Must already exist with index.html or a primary file inside.',
          ),
        filename: z
          .string()
          .optional()
          .describe(
            'Optional path within the directory (e.g. "diagram.html"). If omitted the URL points at the directory root and the server resolves index.html.',
          ),
      },
      async ({ directory, filename }) => {
        if (!sandboxId) {
          return {
            content: [{ type: 'text', text: 'ERROR: SANDBOX_ID env var is empty — cannot build URL.' }],
          }
        }
        if (!/^[a-zA-Z0-9-]+$/.test(sandboxId)) {
          return {
            content: [{ type: 'text', text: 'ERROR: SANDBOX_ID contains invalid characters.' }],
          }
        }
        // Enforce artifact root to prevent the model from serving arbitrary filesystem paths.
        const normalised = directory.replace(/\/+$/, '')
        if (normalised !== ARTIFACT_ROOT && !normalised.startsWith(ARTIFACT_ROOT + '/')) {
          return {
            content: [{ type: 'text', text: `ERROR: directory must be under ${ARTIFACT_ROOT}/ — got: ${directory}` }],
          }
        }
        if (!existsSync(directory)) {
          return {
            content: [{ type: 'text', text: `ERROR: directory does not exist: ${directory}` }],
          }
        }
        if (artifactServerCount >= MAX_ARTIFACT_SERVERS) {
          return {
            content: [{ type: 'text', text: `ERROR: too many artifact servers spawned (max ${MAX_ARTIFACT_SERVERS}) in one session.` }],
          }
        }
        // Reject filenames containing traversal sequences before embedding in URL path.
        if (filename && (filename.includes('..') || filename.includes('\0'))) {
          return {
            content: [{ type: 'text', text: 'ERROR: filename must not contain path traversal sequences.' }],
          }
        }
        const port = await findFreePort()
        const child = spawn(
          'python3',
          ['-m', 'http.server', String(port), '--directory', directory, '--bind', '0.0.0.0'],
          { detached: true, stdio: 'ignore', cwd: '/tmp' },
        )
        // Log spawn errors so failures surface in sandbox stderr rather than silently returning a dead URL.
        child.on('error', (err) => {
          process.stderr.write(`register_artifact: spawn error: ${err.message}\n`)
        })
        child.unref()
        // Wait until the HTTP server is actually accepting connections (up to 3 s).
        const ready = await waitForPort(port)
        if (!ready) {
          return {
            content: [{ type: 'text', text: `ERROR: HTTP server on port ${port} did not become ready in time.` }],
          }
        }
        // Commit the counter only after the server is confirmed ready.
        artifactServerCount++
        const path = filename ? `/${filename.replace(/^\/+/, '')}` : '/'
        const url = `https://artifact-${sandboxId}-${port}.example.com${path}`
        return {
          content: [
            {
              type: 'text',
              text: `Artifact server started.\n  url: ${url}\n  port: ${port}\n  directory: ${directory}\nUse this exact URL in your final answer.`,
            },
          ],
        }
      },
    ),
  ],
})

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `
You are a research agent running inside a sandbox VM. The user asks you to
investigate something and return a clear, conversational summary.

If — and only if — your answer benefits from a visual artifact (a diagram, a
chart, an HTML report, a rendered document), render one and serve it over
HTTP so the user can see it. Otherwise, return text only.

CRITICAL — markdown rule (no exceptions):
Whenever the user (or the orchestrator on behalf of the user) asks for ANY of
these — a PRD, design doc, README, spec, notes, writeup, one-pager, goal
document, plan, "markdown", a "document", a "file", an outline you'd format
with headings, bullet lists, or tables — you MUST do exactly this sequence:

  1. Compose the markdown content in a local string. DO NOT include
     \`\`\`markdown fences.
  2. Call mcp__sandbox-artifact__render_grip with that string as the
     "markdown" argument and a short "title".
  3. Wait for it to return a URL beginning with
     "https://artifact-${sandboxId}-".
  4. Final answer must contain BOTH:
     (a) a single short sentence with the URL — e.g. "I wrote the design doc; it is at <URL>."
     (b) the full source content verbatim, in a fenced \`markdown\` (or
         \`mermaid\`) code block — copy it from the BEGIN/END SOURCE markers
         in the render tool's response. The orchestrator only sees this
         final text, so without the source it is blind to what was rendered
         and cannot answer follow-up questions like "summarize what you
         made" without re-running you.
     Format example:
       I wrote the design doc; it is at https://artifact-abc-1234.example.com/.
       \`\`\`markdown
       # Title
       ...full source...
       \`\`\`

The word "file" in the orchestrator's request is NOT a request to use the
Write tool. It is a colloquial way of asking for a rendered document. The
orchestrator phrases requests as "make me a markdown file about X" or
"create a goal document" — both mean: render via render_grip.

VIOLATIONS that count as bugs:
  • Returning the markdown content as raw inline prose (not wrapped in a
    fenced code block). The source MUST appear in a fenced \`markdown\` (or
    \`mermaid\`) block per rule 4(b) above — not as unwrapped flowing text.
  • Calling Bash or Write to dump the markdown to a file and skipping
    render_grip. Use render_grip; it handles the file and the server.
    The Write tool is for code files / sandbox configuration, NEVER for
    user-requested document content. If you find yourself about to call
    Write with markdown content, STOP and call render_grip instead.
  • Calling register_artifact for markdown. Use render_grip — it is
    strictly better for markdown content.
  • Saying "I cannot render markdown" — render_grip is provided to you for
    exactly this purpose. If render_grip returns an ERROR, surface that
    error in your final answer rather than falling back to inline markdown.
  • Saying "I created the file at <path>" without an artifact URL — the
    orchestrator sees only your final text and the artifact_ready data
    channel. A file on the sandbox filesystem is invisible to the user
    until render_grip serves it over HTTP.

Tools available:
  • Bash, Read, Write, WebSearch — for investigating, computing, writing files.
  • render_mermaid — preferred path for ANY mermaid/flowchart/sequence diagram.
  • render_grip — preferred path for ANY markdown content the user asked for
    (PRD, design doc, README, notes, spec, writeup). GitHub-styled rendering.
  • register_artifact — fallback for arbitrary HTML you authored yourself.

Rendering protocol — pick ONE, never both for the same artifact:

  Mermaid diagrams (preferred — server-side rendered to SVG, no CDN, always works):
    • Call render_mermaid({ diagram: '<raw mermaid syntax>', theme?: 'default'|'forest'|'dark'|'neutral', title?: '...' }).
    • Pass ONLY the mermaid source (no \`\`\`mermaid fences). The tool writes
      the SVG and HTML, spawns a detached HTTP server, and returns the URL.
    • Use the URL VERBATIM in your final answer.

  Markdown documents (preferred — server-side grip rendering, GitHub styling):
    • Call render_grip({ markdown: '<raw markdown>', title?: '...' }).
    • Pass ONLY the raw markdown source — no surrounding code fences. The tool
      writes the file, spawns a detached grip server, and returns the URL.
    • Use this whenever the user asks for a PRD, design doc, README, spec,
      notes, writeup, or any "markdown" output. Do NOT call register_artifact
      for markdown — render_grip is strictly better.
    • Use the URL it returns VERBATIM.

  Other artifacts (custom HTML, JSON dashboards, plain reports):
    1. Write the file(s) into /tmp/artifacts/run-<id>/ (use Write or Bash).
    2. Call register_artifact({ directory: '/tmp/artifacts/run-<id>' [, filename: 'foo.html'] }).
    3. Use the URL it returns VERBATIM.

URL rules (these are all errors — failing to follow them breaks the user):
  • The ONLY valid artifact URL is the one register_artifact returns.
  • The current sandbox ID is "${sandboxId}". This value is provided so you
    can recognize a correct URL, NOT so you can construct one. The port
    component is unknowable until register_artifact picks it.
  • NEVER construct "artifact-${sandboxId}-<port>.example.com" yourself.
    NEVER use placeholders like "sandbox", "your-sandbox-id", "<sid>", or
    a number you guess — register_artifact is the only correct source.
  • NEVER use "data:text/html,..." or any other data: URL. The downstream
    share_screen tool rejects non-https URLs and the iframe cannot render
    inline HTML. If you find yourself building a data: URL, STOP and call
    register_artifact instead.
  • NEVER inline raw HTML or mermaid syntax into your final text. Write to
    disk, register_artifact, return the URL.

Final answer rules:
  • Plain text. The voice agent reads it and decides whether to share_screen.
  • If you rendered an artifact, weave the URL register_artifact returned
    naturally into the summary ("I built a diagram at <URL>").
  • If you didn't render anything, just answer in prose.
`.trim()

// Log the registered MCP tool names at startup so we can verify the SDK saw
// each tool we expect (helps diagnose "subagent didn't call render_grip"
// type bugs from log inspection alone). The createSdkMcpServer return shape
// varies by SDK version so we walk the object defensively, looking at the
// top level and one level of common nested keys ("tools", "_tools",
// "instance", "server").
try {
  const probes = [artifactServer, artifactServer?.tools, artifactServer?._tools,
    artifactServer?.instance, artifactServer?.server, artifactServer?.server?.tools]
  let toolNames = []
  for (const p of probes) {
    if (!p) continue
    if (Array.isArray(p)) {
      const names = p.map((t) => t?.name).filter(Boolean)
      if (names.length > toolNames.length) toolNames = names
    } else if (typeof p === 'object') {
      // Dictionary form: { render_mermaid: {...}, render_grip: {...} }
      const keys = Object.keys(p).filter((k) => p[k] && typeof p[k] === 'object' && (p[k].name || p[k].handler))
      if (keys.length > toolNames.length) toolNames = keys
    }
  }
  process.stderr.write(`research.mjs: registered MCP tools = ${JSON.stringify(toolNames)}\n`)
} catch { /* best-effort introspection */ }

async function main() {
  let text = ''
  try {
    const stream = query({
      prompt,
      options: {
        model,
        systemPrompt: SYSTEM_PROMPT,
        // Built-in tools + every tool exported from our SDK MCP server.
        // Our tool's full name follows MCP's `mcp__<server>__<tool>` convention.
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'WebSearch',
          'mcp__sandbox-artifact__register_artifact',
          'mcp__sandbox-artifact__render_mermaid',
          'mcp__sandbox-artifact__render_grip',
        ],
        mcpServers: { 'sandbox-artifact': artifactServer },
        // 20 was tight for "describe how X works" prompts that need to read
        // multiple files before producing an artifact — the subagent hit the
        // ceiling mid-exploration and returned a "max turns" error which the
        // orchestrator surfaced as a silent stall. 50 gives breathing room for
        // multi-file reads while still bounding cost.
        maxTurns: 50,
        // Adaptive thinking with low effort. With thinking disabled, the SDK
        // shortcut past register_artifact and hallucinated URLs in its final
        // answer (e.g. "artifact-sandbox-3000.example.com" — both pieces
        // invented). 'low' restores protocol compliance at near-zero latency
        // cost; the model still picks depth based on the request.
        effort: 'low',
      },
    })
    for await (const message of stream) {
      if (message.type === 'result' && 'result' in message) {
        text = String(message.result)
        break
      }
    }
  } catch (err) {
    text = `Research error: ${err instanceof Error ? err.message : String(err)}`
  }

  if (!text) text = 'Research complete.'
  process.stdout.write(JSON.stringify({ text }) + '\n')
}

main().catch((err) => {
  process.stderr.write(`research.mjs fatal: ${err}\n`)
  process.stdout.write(
    JSON.stringify({ text: `Fatal error: ${err instanceof Error ? err.message : String(err)}` }) + '\n',
  )
  process.exit(1)
})
