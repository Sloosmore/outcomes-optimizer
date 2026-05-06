/**
 * Minimal ULID generator — no external dependencies.
 *
 * Produces a 26-character Crockford Base32 string that is monotonically
 * sortable by creation time. Good enough for event IDs; swap for the `ulid`
 * package if you need stricter monotonic guarantees within the same ms.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len; i > 0; i--) {
    const mod = now % 32;
    str = ENCODING[mod] + str;
    now = (now - mod) / 32;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let str = "";
  for (const b of bytes) {
    str += ENCODING[b % 32];
  }
  return str;
}

/** Generate a ULID string (26 chars, time-sortable). */
export function ulid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
