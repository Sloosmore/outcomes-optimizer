/**
 * Wraps a rendered Mermaid SVG in a self-contained HTML page that fits to viewport
 * and offers pan/zoom controls. Mirrors the look of the local `claude-mermaid`
 * preview so sandbox-served diagrams render the same way as the dev tool.
 */

const STYLE = `
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

const SCRIPT = `
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s/>]+)/gi, '')
    .replace(/(\s+(?:href|xlink:href|src|action|formaction)\s*=\s*")(?:javascript|data):[^"]*/gi, '$1#')
    .replace(/(\s+(?:href|xlink:href|src|action|formaction)\s*=\s*')(?:javascript|data):[^']*/gi, "$1#")
    // Strip external resource references from <use> and <image> elements to prevent
    // SSRF via non-browser SVG consumers (SVG-to-PNG converters, server-side processors).
    // Fragment-only hrefs (#id) used by Mermaid for internal defs are preserved.
    .replace(/(<(?:use|image)\b[^>]*?\s(?:href|xlink:href)\s*=\s*")(?!#)[^"]*/gi, '$1#')
    .replace(/(<(?:use|image)\b[^>]*?\s(?:href|xlink:href)\s*=\s*')(?!#)[^']*/gi, "$1#")
}

/**
 * Mermaid embeds the diagram's natural background as inline style on the root
 * <svg> element (e.g. style="background-color: white"). Extract it so we can
 * paint the surrounding viewport to match — without this the diagram tile sits
 * as a contrasting rectangle on the dark canvas chrome.
 */
function extractSvgBackground(svgContent: string): string | null {
  const opening = svgContent.match(/<svg\b[^>]*>/i)
  if (!opening) return null
  const styleAttr = opening[0].match(/style\s*=\s*"([^"]*)"/i)
  if (!styleAttr) return null
  const bg = styleAttr[1].match(/background(?:-color)?\s*:\s*([^;]+)/i)
  if (!bg) return null
  const value = bg[1].trim()
  // Allow only plain color values — reject url(), expression(), or anything that could
  // fetch external resources or execute CSS-level code.
  if (!/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|transparent)$/.test(value)) {
    return null
  }
  return value
}

/**
 * Build the preview HTML for a rendered SVG.
 * @param svgContent The full <svg>…</svg> string from mermaid-cli.
 * @param id The diagram id (used as page title).
 */
export function renderPreviewHtml(svgContent: string, id: string): string {
  const safeId = escapeHtml(id)
  const timestamp = escapeHtml(new Date().toLocaleTimeString())
  const svgBg = extractSvgBackground(svgContent) ?? '#1a1a1a'
  const viewportStyle = `background: ${escapeHtml(svgBg)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Mermaid: ${safeId}</title>
<style>${STYLE}</style>
</head>
<body data-diagram-id="${safeId}">
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
  <div class="diagram-wrapper">${sanitizeSvg(svgContent)}</div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`
}
