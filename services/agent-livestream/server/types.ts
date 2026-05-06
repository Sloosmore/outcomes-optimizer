import type { JWTPayload } from 'jose'

export type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}
