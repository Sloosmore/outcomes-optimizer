/**
 * Single global wallpaper for the stage. Per-chat overrides come later if we
 * want them; v1 keeps it simple. Use a small inline data URI so we never make
 * a network request for it (and it works offline / in tests).
 */
export const STAGE_WALLPAPER_URL = (
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">' +
      '<defs>' +
        '<radialGradient id="glow1" cx="20%" cy="30%" r="55%">' +
          '<stop offset="0%" stop-color="#7c3aed" stop-opacity="0.85"/>' +
          '<stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="glow2" cx="85%" cy="75%" r="55%">' +
          '<stop offset="0%" stop-color="#ec4899" stop-opacity="0.7"/>' +
          '<stop offset="100%" stop-color="#ec4899" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="glow3" cx="60%" cy="20%" r="40%">' +
          '<stop offset="0%" stop-color="#3b82f6" stop-opacity="0.6"/>' +
          '<stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="base" x1="0%" y1="0%" x2="0%" y2="100%">' +
          '<stop offset="0%" stop-color="#1e1b4b"/>' +
          '<stop offset="100%" stop-color="#0c0a1f"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<rect width="1600" height="1000" fill="url(#base)"/>' +
      '<rect width="1600" height="1000" fill="url(#glow1)"/>' +
      '<rect width="1600" height="1000" fill="url(#glow2)"/>' +
      '<rect width="1600" height="1000" fill="url(#glow3)"/>' +
    '</svg>'
  )
)
