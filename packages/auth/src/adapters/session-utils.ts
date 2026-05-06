import type { Session } from '@supabase/supabase-js'
import type { AuthSession } from './types.js'

export function mapSupabaseSession(session: Session): AuthSession {
  return {
    accessToken: session.access_token,
    user: {
      id: session.user.id,
      email: session.user.email ?? '',
      metadata: session.user.user_metadata ?? {},
    },
    expiresAt: session.expires_at ?? undefined,
  }
}
