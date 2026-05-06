/**
 * Voice-tool JWT minting and verification.
 *
 * Short-lived HS256 JWTs are issued for voice agent tool callbacks.
 * They carry user_id and room_id and are verified at the /api/voice-tool
 * endpoint — which sits OUTSIDE the Supabase JWT wall.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'

export interface VoiceToolJwtClaims {
  user_id: string
  room_id: string
  scope: 'voice_tool_exec'
  /**
   * Project the user was viewing in the top bar at chat-join time.
   * Used by the dispatch tool so dispatched skills land in the active project,
   * not the per-user fallback (`project:<userId>`). Optional — older tokens
   * without this claim continue to work and fall back to the per-user project.
   */
  active_project?: string
}

export class VoiceToolJwtError extends Error {
  readonly code: 'INVALID' | 'EXPIRED' | 'MISSING_CLAIMS'
  constructor(
    message: string,
    code: 'INVALID' | 'EXPIRED' | 'MISSING_CLAIMS'
  ) {
    super(message)
    this.name = 'VoiceToolJwtError'
    this.code = code
  }
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function mintVoiceToolJwt(
  userId: string,
  roomId: string,
  secret: string,
  activeProject?: string,
): Promise<string> {
  const payload: Record<string, unknown> = {
    user_id: userId,
    room_id: roomId,
    scope: 'voice_tool_exec',
  }
  if (activeProject) payload['active_project'] = activeProject
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30m')
    .setIssuedAt()
    .sign(encodeSecret(secret))
}

export async function verifyVoiceToolJwt(
  token: string,
  secret: string
): Promise<VoiceToolJwtClaims> {
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, encodeSecret(secret), { algorithms: ['HS256'] })
    payload = result.payload as Record<string, unknown>
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      throw new VoiceToolJwtError('Token expired', 'EXPIRED')
    }
    throw new VoiceToolJwtError('Invalid token', 'INVALID')
  }

  const { user_id, room_id, scope, active_project } = payload
  if (
    typeof user_id !== 'string' || !user_id ||
    typeof room_id !== 'string' || !room_id ||
    scope !== 'voice_tool_exec'
  ) {
    throw new VoiceToolJwtError('Missing or invalid claims', 'MISSING_CLAIMS')
  }

  return {
    user_id,
    room_id,
    scope: 'voice_tool_exec',
    ...(typeof active_project === 'string' && active_project ? { active_project } : {}),
  }
}
