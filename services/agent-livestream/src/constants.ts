// ─── Data Freshness ───────────────────────────────────────────────────────────

/** React Query stale time for org/project data (1 minute) */
export const ORG_STALE_TIME_MS = 60_000
/** React Query stale time for chat/call list (30 seconds) */
export const CHATS_STALE_TIME_MS = 30_000
/** Six hours in milliseconds — used for "recently finished" task window */
export const SIX_HOURS_MS = 21_600_000

// ─── Orb ──────────────────────────────────────────────────────────────────────

/** Perlin noise texture used by the WebGL orb shader. Hosted on ElevenLabs' public CDN. */
export const ORB_PERLIN_NOISE_URL = 'https://storage.googleapis.com/eleven-public-cdn/images/perlin-noise.png'

// ─── Agent Detail Panel ───────────────────────────────────────────────────────

/** Number of events fetched per page in the agent detail panel */
export const EVENTS_PAGE_SIZE = 100
/** Distance from bottom (px) at which the panel is considered "near bottom" */
export const EVENTS_NEAR_BOTTOM_PX = 80
/** Polling interval (ms) for the live tail query */
export const EVENTS_POLL_INTERVAL_MS = 3000
/** Estimated average row height (px) used to calculate the unloaded-events spacer */
export const EVENTS_EST_ROW_HEIGHT_PX = 58

// ─── State Snapshot ──────────────────────────────────────────────────────────

/**
 * Fallback total story count used to estimate progress when the PRD story count
 * is not yet known. Used in the progress ring calculation.
 */
export const UNKNOWN_TOTAL_STORIES = 8

// ─── Terrain View ─────────────────────────────────────────────────────────────

/** Camera follow: interval (ms) between setCenter() calls when tracking a cursor */
export const TERRAIN_FOLLOW_INTERVAL_MS = 150
/** Camera follow: easing duration (ms) for each incremental setCenter() call */
export const TERRAIN_FOLLOW_EASE_DURATION_MS = 180
/** Camera follow: zoom level applied when following a cursor */
export const TERRAIN_FOLLOW_ZOOM = 1.8
/** Camera follow: zoom + duration (ms) for the initial jump to the followed cursor */
export const TERRAIN_FOLLOW_INITIAL_ZOOM_DURATION_MS = 600
/** Terrain cursors: zoom level at which the process-name badge appears on the cursor */
export const TERRAIN_BADGE_ZOOM_THRESHOLD = 0.55
/** Terrain labels: cursor proximity (px) below which individual resource labels fade out */
export const TERRAIN_CURSOR_PROXIMITY_PX = 120

// ─── Cursor Impulse Physics ───────────────────────────────────────────────────
// Speed boost and duration applied to a cursor when a tool-call event arrives.
// Tier hierarchy (highest to lowest): subagent > generic > message.
// Impulse tiers — events are the sole energy source for cursor movement.
// baseSpeed is 0, so without events the cursor sits still. Each event type
// provides a boost that friction slowly decays. An actively-working agent
// receives frequent events that keep it moving; a stalled agent goes quiet.
//
// generic > message is intentional: generic tool calls (Bash, Read, etc.) are
// frequent short bursts, so a quick strong impulse reads better than a slow fade.
// message tier represents assistant text output — softer, longer impulse.

/** Subagent impulse: speed boost applied when Agent/Skill tools fire */
export const CURSOR_SUBAGENT_SPEED_BOOST = 160
/** Subagent impulse: duration (ms) of the speed boost */
export const CURSOR_SUBAGENT_DURATION_MS = 6000
/** Generic tool impulse: speed boost applied for Bash, Read, Write, token_usage, etc. */
export const CURSOR_GENERIC_SPEED_BOOST = 120
/** Generic tool impulse: duration (ms) of the speed boost */
export const CURSOR_GENERIC_DURATION_MS = 4000
/** Message impulse: speed boost applied for assistant message output */
export const CURSOR_MESSAGE_SPEED_BOOST = 70
/** Message impulse: duration (ms) of the speed boost */
export const CURSOR_MESSAGE_DURATION_MS = 5000

/** Orbit radius (px) for co-located cursors sharing a terrain node. Zero when only one process is on a node. */
export const CURSOR_ORBIT_RADIUS_PX = 42

// ─── Flyby Animation ──────────────────────────────────────────────────────────

/** Total duration (ms) for a single flyby animation cycle (fly-out + hold + return) */
export const FLYBY_DISPLAY_MS = 2400

// ─── Onboarding ───────────────────────────────────────────────────────────────

/** CLI install command shown on the onboarding page */
export const CLI_INSTALL_COMMAND = 'npm install -g @duoidal/cli && duoidal auth login'

