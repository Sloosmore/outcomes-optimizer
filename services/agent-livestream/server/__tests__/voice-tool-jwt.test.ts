import { describe, it, expect } from 'vitest'
import { mintVoiceToolJwt, verifyVoiceToolJwt, VoiceToolJwtError } from '../lib/voice-tool-jwt.js'

const SECRET = 'test-voice-tool-secret-32chars!!'

describe('voice-tool JWT', () => {
  it('roundtrip: mint then verify returns correct claims', async () => {
    const token = await mintVoiceToolJwt('00000000-0000-4000-8000-000000000001', 'room-abc', SECRET)
    const claims = await verifyVoiceToolJwt(token, SECRET)
    expect(claims.user_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(claims.room_id).toBe('room-abc')
    expect(claims.scope).toBe('voice_tool_exec')
  })

  it('verify returns VoiceToolJwtClaims shape', async () => {
    const token = await mintVoiceToolJwt('8787b032-f58a-49e4-8156-7eda9c054b2f', 'room-xyz', SECRET)
    const claims = await verifyVoiceToolJwt(token, SECRET)
    expect(claims).toHaveProperty('user_id')
    expect(claims).toHaveProperty('room_id')
    expect(claims).toHaveProperty('scope')
    expect(typeof claims.user_id).toBe('string')
    expect(typeof claims.room_id).toBe('string')
    expect(claims.scope).toBe('voice_tool_exec')
  })

  it('tampered token → throws VoiceToolJwtError with code=INVALID', async () => {
    const token = await mintVoiceToolJwt('00000000-0000-4000-8000-000000000001', 'room-abc', SECRET)
    const corrupted = token + 'x'
    await expect(verifyVoiceToolJwt(corrupted, SECRET)).rejects.toSatisfy(
      (e: unknown) => e instanceof VoiceToolJwtError && e.code === 'INVALID'
    )
  })

  it('wrong secret → throws VoiceToolJwtError with code=INVALID', async () => {
    const token = await mintVoiceToolJwt('00000000-0000-4000-8000-000000000001', 'room-abc', SECRET)
    await expect(verifyVoiceToolJwt(token, 'wrong-secret')).rejects.toSatisfy(
      (e: unknown) => e instanceof VoiceToolJwtError && e.code === 'INVALID'
    )
  })

  it('missing user_id claim → throws VoiceToolJwtError with code=MISSING_CLAIMS', async () => {
    // Manually craft a JWT that is valid HS256 but missing user_id
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(SECRET)
    const token = await new SignJWT({ room_id: 'room-abc', scope: 'voice_tool_exec' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(secret)
    await expect(verifyVoiceToolJwt(token, SECRET)).rejects.toSatisfy(
      (e: unknown) => e instanceof VoiceToolJwtError && e.code === 'MISSING_CLAIMS'
    )
  })
})
