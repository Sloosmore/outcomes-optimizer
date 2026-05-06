import { Hono } from 'hono'
import type { JWTPayload } from 'jose'
import { supabase } from '../lib/supabase.js'

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export const userRouter = new Hono<Env>()

userRouter.patch('/onboarded', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload
  const userId = typeof payload.sub === 'string' ? payload.sub : null
  if (!userId) return c.json({ error: 'Invalid token — no sub claim' }, 401)

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    user_metadata: { is_onboarded: true },
  })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})
