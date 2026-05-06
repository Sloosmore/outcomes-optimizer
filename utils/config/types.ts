import { z } from 'zod'
import { configSchema, emailAdapterSchema, identitySchema, evalSchema, evalDataSchema } from './schema.js'

export type Config = z.infer<typeof configSchema>
export type DatabaseAdapter = Config['database']['adapter']
export type CLIAdapter = Config['cli']['adapter']
export type EmailAdapter = z.infer<typeof emailAdapterSchema>
export type IdentityConfig = z.infer<typeof identitySchema>
export type EvalConfig = z.infer<typeof evalSchema>
export type EvalDataConfig = z.infer<typeof evalDataSchema>
